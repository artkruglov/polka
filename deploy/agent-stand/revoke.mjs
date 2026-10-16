#!/usr/bin/env node
// Measures how soon a disabled service account stops working
// (deploy/agent-stand/README.md). A throwaway bot gets a task token and
// repeats one allowed read; once it has worked three times in a row the
// admin disables the bot, and the script times the first refusal of that
// same read. It measures the server, not the agent: what the agent already
// read stays read.
//
//   node deploy/agent-stand/revoke.mjs --account <file with {"name","password"}> [--step 200]
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    origin: { type: "string", default: "http://127.0.0.1:4390" },
    account: { type: "string" },
    tokens: { type: "string", default: ".local/agent-stand/tokens.json" },
    step: { type: "string", default: "200" },
  },
});
if (!values.account) throw new Error("--account <file> is required");
const { origin } = values;
const step = Number(values.step);
const shelf = JSON.parse(await readFile(values.tokens, "utf8")).shelves.analytics;

let cookie = "";
async function call(method, path, body) {
  const response = await fetch(origin + path, {
    method,
    headers: { origin, cookie, "x-polka-shelf": shelf, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const line of response.headers.getSetCookie?.() ?? [])
    if (line.startsWith("polka_session=")) cookie = line.split(";")[0];
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const account = JSON.parse(await readFile(values.account, "utf8"));
await call("POST", "/api/login", { name: account.name, password: account.password });

const bot = await call("POST", "/api/service-accounts", {
  name: `revoke-check-${Date.now()}`,
  scopes: ["read"],
  ttlDays: 1,
});
const task = await fetch(`${origin}/api/v1/task-token`, {
  method: "POST",
  headers: { authorization: `Bearer ${bot.token}`, "content-type": "application/json" },
  body: JSON.stringify({ minutes: 10, taskId: "revoke-check" }),
}).then((response) => response.json());
const read = async () => {
  try {
    return (await fetch(`${origin}/api/v1/works`, { headers: { authorization: `Bearer ${task.token}` } })).status;
  } catch {
    return "network";
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let works = 0;
for (let i = 0; i < 20 && works < 3; i++) {
  works = (await read()) === 200 ? works + 1 : 0;
  await sleep(step);
}
if (works < 3) throw new Error("the allowed read does not work before the revocation: nothing to measure");

const t0 = performance.now();
await call("POST", `/api/service-accounts/${bot.servicePrincipal.id}/disable`);
const answered = performance.now() - t0;
let refusal = null;
let status = 200;
while (performance.now() - t0 < 30_000) {
  status = await read();
  if (status !== 200) {
    refusal = performance.now() - t0;
    break;
  }
  await sleep(step);
}
console.log(
  JSON.stringify(
    {
      read: "GET /api/v1/works с токеном задачи",
      before: "3 успешных чтения подряд",
      disableAnsweredMs: Math.round(answered),
      firstRefusalMs: refusal === null ? null : Math.round(refusal),
      refusalStatus: status,
      stepMs: step,
      note: "Точность — шаг опроса. Уже прочитанное агентом остаётся у него.",
    },
    null,
    2,
  ),
);
process.exitCode = refusal === null || ![401, 403].includes(status) ? 1 : 0;
