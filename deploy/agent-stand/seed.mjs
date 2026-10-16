#!/usr/bin/env node
// Prepares a local Полка for the agent stand (deploy/agent-stand/README.md):
// two department shelves, two service accounts with different rights on one
// of them, and a synthetic sales table. Runs on the host, never in the VM.
//
//   node deploy/agent-stand/seed.mjs --account <file with {"name","password"}> [--out .local/agent-stand]
//
// The account must be a company admin (npm run admin -- company admin <login>)
// on an installation with TEAM_SHELVES=on and SERVICE_ACCOUNTS=on. Service
// tokens go to <out>/tokens.json (mode 600) and are printed nowhere.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    origin: { type: "string", default: "http://127.0.0.1:4390" },
    account: { type: "string" },
    out: { type: "string", default: ".local/agent-stand" },
  },
});
if (!values.account) throw new Error("--account <file> is required");
const origin = values.origin;
const out = values.out;

const SHELVES = { analytics: "Аналитика (демо)", finance: "Финансы (демо)" };
const BOTS = {
  "report-bot": ["capture", "revise"],
  "reader-bot": ["read", "source:read"],
};

let cookie = "";
async function call(method, path, body, shelfId) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      origin,
      cookie,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(shelfId ? { "x-polka-shelf": shelfId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = response.headers.getSetCookie?.() ?? [];
  for (const line of set) if (line.startsWith("polka_session=")) cookie = line.split(";")[0];
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const account = JSON.parse(await readFile(values.account, "utf8"));
await call("POST", "/api/login", { name: account.name, password: account.password });

const shelves = {};
const listed = (await call("GET", "/api/shelves")).items;
for (const [key, name] of Object.entries(SHELVES)) {
  shelves[key] = listed.find((shelf) => shelf.name === name)?.id ?? (await call("POST", "/api/shelves", { name })).id;
}

await mkdir(out, { recursive: true });
const tokensFile = join(out, "tokens.json");
let previous = {};
try {
  previous = JSON.parse(await readFile(tokensFile, "utf8"));
} catch {}

const bots = {};
const existing = await call("GET", "/api/service-accounts", undefined, shelves.analytics);
const items = Array.isArray(existing) ? existing : (existing.items ?? existing.servicePrincipals ?? []);
for (const [name, scopes] of Object.entries(BOTS)) {
  let found = items.find((item) => item.name === name);
  const kept = found && previous.bots?.[name]?.id === found.id ? previous.bots[name] : null;
  if (kept?.token && kept.scopes.join() === scopes.join()) {
    bots[name] = kept;
    continue;
  }
  // Other rights than wanted: the bot is disabled and made again (a
  // disabled account frees its name).
  if (found && kept && kept.scopes.join() !== scopes.join()) {
    await call("POST", `/api/service-accounts/${found.id}/disable`, undefined, shelves.analytics);
    found = undefined;
  }
  // A bot whose token was lost gets a new one; the old is revoked.
  const made = found
    ? await call("POST", `/api/service-accounts/${found.id}/rotate`, { ttlDays: 30 }, shelves.analytics)
    : await call("POST", "/api/service-accounts", { name, scopes, ttlDays: 30 }, shelves.analytics);
  bots[name] = { id: found?.id ?? made.servicePrincipal.id, scopes, token: made.token };
}

// The other department's shelf holds one synthetic work, so «the agent
// cannot see it» is shown on something that exists. A one-off bot saves it
// and is disabled at once.
let financeWork = previous.financeWork ?? null;
if (!financeWork) {
  const made = await call(
    "POST",
    "/api/service-accounts",
    { name: `finance-seed-${Date.now()}`, scopes: ["capture"], ttlDays: 1 },
    shelves.finance,
  );
  const saved = await fetch(`${origin}/api/v1/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${made.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      key: randomUUID(),
      title: "Бюджет 2027 — черновик (демо)",
      kind: "file",
      name: "budget-2027.csv",
      text: "статья,сумма_руб\nФОТ,120000000\nИнфраструктура,34000000\nМаркетинг,18000000\n",
    }),
  }).then((response) => response.json());
  financeWork = saved.artifactId;
  await call("POST", `/api/service-accounts/${made.servicePrincipal.id}/disable`, undefined, shelves.finance);
}

await writeFile(tokensFile, JSON.stringify({ origin, shelves, bots, financeWork }, null, 2) + "\n", {
  mode: 0o600,
});
await chmod(tokensFile, 0o600);

// Synthetic sales: regions × months, fixed seed, no real data.
let seed = 42;
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const rows = ["month,region,orders,revenue_rub"];
for (const month of ["2026-07", "2026-08", "2026-09"])
  for (const region of ["Москва", "Санкт-Петербург", "Казань", "Новосибирск", "Екатеринбург"]) {
    const orders = 200 + Math.round(random() * 800);
    rows.push(`${month},${region},${orders},${orders * (1500 + Math.round(random() * 1500))}`);
  }
await mkdir(join(out, "input"), { recursive: true });
await writeFile(join(out, "input", "sales.csv"), rows.join("\n") + "\n");

console.log(JSON.stringify({ shelves, bots: Object.fromEntries(Object.entries(bots).map(([n, b]) => [n, b.scopes])) }));
