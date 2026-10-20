#!/usr/bin/env node
// The firm's outside world on the finance stand (deploy/finance-stand/README.md):
// two banks, an EDO operator, a ledger in the shape of 1C and the mailbox,
// each an API only, plus the counterparties who answer the agents' letters
// (sim.mjs). Runs as root in the VM on 127.0.0.1:7071; no dependencies.
//
// The banks answer only with the bank token (/etc/finance/bank-token),
// which the coordinator holds and a sandbox never gets. EDO, ledger and
// mail are readable on the loopback; a sandbox reaches them through Squid
// and only with GET (p_fin). Every write needs the effect gateway's token
// and an idempotency key: the same key returns the first answer.
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSim } from "./sim.mjs";
import { query } from "./odata.mjs";
import { bankAccounts, statementPage } from "./tapi.mjs";

const PORT = Number(process.env.FIN_PORT ?? 7071);
const DIR = process.env.FIN_DATA ?? "/var/lib/finance";
const COMPANY = join(DIR, "company");
const FILE = join(DIR, "systems.json");
const read = (f) => readFileSync(f, "utf8").trim();
const EFFECTS_TOKEN = read(process.env.FIN_EFFECTS_TOKEN ?? "/etc/contour/effects-token");
const BANK_TOKEN = read(process.env.FIN_BANK_TOKEN ?? "/etc/finance/bank-token");

const company = JSON.parse(await readFile(join(COMPANY, "company.json"), "utf8"));
const base = {
  bankA: JSON.parse(await readFile(join(COMPANY, "bank-a.json"), "utf8")),
  bankB: await readFile(join(COMPANY, "bank-b.txt")),
  edo: JSON.parse(await readFile(join(COMPANY, "edo.json"), "utf8")),
  ledger: JSON.parse(await readFile(join(COMPANY, "ledger.json"), "utf8")),
};
const nextDay = (d) => new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);
const empty = () => ({
  clock: nextDay(company.firm.period.asOf),
  keys: {},
  edo: [], // documents that appeared after the quarter: requests, drafts, answers
  ops: [], // bank operations that appeared after the quarter (bank a, T-API shape)
  ledger: [], // drafts written through the gateway
  mailboxes: {},
  outbox: [],
  scheduled: [], // what the counterparties will do, and when
});
let db = empty();
try {
  db = { ...empty(), ...JSON.parse(await readFile(FILE, "utf8")) };
} catch {}
const save = async () => {
  await mkdir(DIR, { recursive: true });
  await writeFile(`${FILE}.tmp`, JSON.stringify(db, null, 1));
  await rename(`${FILE}.tmp`, FILE);
};
const id = (prefix) => `${prefix}-${randomBytes(3).toString("hex")}`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const same = (given, want) => {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};
const sim = createSim({ company, db, id, sha256 });

async function once(req, make) {
  const key = String(req.headers["idempotency-key"] ?? "");
  if (!key) return [400, { error: "idempotency-key is required" }];
  if (db.keys[key]) return [200, { ...db.keys[key], repeated: true }];
  const [status, body] = await make();
  if (status < 300) db.keys[key] = body;
  await save();
  return [status, body];
}

const ledgerSet = (name) => [...(base.ledger[name] ?? []), ...db.ledger.filter((d) => d.entity === name)];

const routes = {
  "GET /health": () => [200, { ok: true, clock: db.clock }],

  // ---- bank a: the T-API statement schema (business.tbank.ru/openapi)
  "GET /tbank/api/v4/bank-accounts": () => [200, bankAccounts([company.accounts.a])],
  "GET /tbank/api/v1/statement": (_req, _b, url) =>
    statementPage([...base.bankA, ...db.ops], company.accounts.a.account, url.searchParams),
  // ---- bank b: the «Клиент-банк → 1С» export, windows-1251
  "GET /bankb/statement.txt": () => [200, base.bankB, "text/plain; charset=windows-1251"],

  // ---- EDO: incoming and outgoing documents
  "GET /edo/documents": (_req, _b, url) => {
    const p = url.searchParams;
    const rows = [...base.edo, ...db.edo].filter(
      (d) =>
        (!p.get("dir") || d.dir === p.get("dir")) &&
        (!p.get("status") || d.status === p.get("status")) &&
        (!p.get("inn") || d.inn === p.get("inn")) &&
        (!p.get("kind") || d.kind === p.get("kind")),
    );
    return [200, rows];
  },
  // Ask a counterparty for a missing document (a request in the operator's network).
  "POST /edo/request": (req, body) =>
    once(req, async () => {
      const cp = company.counterparties.find((c) => c.inn === body.inn);
      if (!cp) return [404, { error: "нет такого контрагента" }];
      if (!cp.edo) return [409, { error: "контрагент не в ЭДО: только письмом" }];
      const d = {
        id: id("edo"),
        kind: "request",
        dir: "out",
        inn: cp.inn,
        counterparty: cp.name,
        basis: body.basis,
        text: body.text,
        date: db.clock,
        status: "sent",
        goal: body.goal,
      };
      db.edo.push(d);
      sim.outbound(cp, { kind: "request", basis: body.basis });
      return [201, d];
    }),
  // A draft the firm will sign: a reconciliation act, an UPD of its own.
  "POST /edo/draft": (req, body) =>
    once(req, async () => {
      const cp = company.counterparties.find((c) => c.inn === body.inn);
      if (!cp) return [404, { error: "нет такого контрагента" }];
      const text = String(body.text ?? "");
      const d = {
        id: id("edo"),
        kind: body.kind ?? "recon",
        dir: "out",
        inn: cp.inn,
        counterparty: cp.name,
        basis: body.basis ?? null,
        amount: body.amount ?? null,
        text,
        sha256: sha256(text),
        date: db.clock,
        status: "draft",
        goal: body.goal,
      };
      db.edo.push(d);
      return [201, d];
    }),
  // A person signs; the bytes must be the ones queued.
  "POST /edo/sign": (req, body) =>
    once(req, async () => {
      const d = [...base.edo, ...db.edo].find((x) => x.id === body.id);
      if (!d) return [404, { error: "нет такого документа" }];
      if (!["draft", "awaiting"].includes(d.status)) return [409, { error: `документ ${d.status}` }];
      if (d.sha256 && body.sha256 !== d.sha256)
        return [409, { error: "подписываемые байты не совпадают с черновиком" }];
      const mine = db.edo.find((x) => x.id === d.id) ?? (db.edo.push({ ...d }), db.edo.at(-1));
      Object.assign(mine, { status: d.dir === "out" ? "sent" : "signed", signedBy: body.signer, signed: db.clock });
      if (d.dir === "out")
        sim.outbound(
          company.counterparties.find((c) => c.inn === d.inn),
          { kind: d.kind, doc: mine },
        );
      return [200, mine];
    }),

  // ---- ledger in the shape of 1C's OData interface
  "POST /ledger1c/draft": (req, body) =>
    once(req, async () => {
      if (!/^Document_/.test(body.entity ?? "")) return [422, { error: "только документы, и только черновиком" }];
      const d = { ...(body.fields ?? {}), entity: body.entity, Ref_Key: id("draft"), Posted: false, goal: body.goal };
      db.ledger.push(d);
      return [201, d];
    }),

  // ---- mail: the finance mailbox in, letters out
  "GET /mail/inbox": (_req, _b, url) => {
    const box = url.searchParams.get("box");
    return [200, (db.mailboxes[box] ?? []).filter((m) => !url.searchParams.has("new") || !m.taken)];
  },
  "POST /mail/incoming": async (_req, body) => {
    const m = await sim.letter(body.box ?? "finance", body);
    await save();
    return [201, m];
  },
  "POST /mail/take": async (_req, body) => {
    const m = (db.mailboxes[body.box] ?? []).find((x) => x.id === body.id);
    if (m) m.taken = true;
    await save();
    return [200, { ok: Boolean(m) }];
  },
  "GET /mail/outbox": () => [200, db.outbox],
  "POST /mail/send": (req, body) =>
    once(req, async () => {
      if (!body.to || !body.subject) return [422, { error: "to and subject" }];
      const m = { id: id("out"), at: db.clock, ...body };
      db.outbox.push(m);
      const cp = company.counterparties.find((c) => c.email === body.to);
      if (cp) sim.outbound(cp, { kind: "letter", basis: body.basis, subject: body.subject, amount: body.amount });
      return [201, m];
    }),

  // ---- the simulator's clock: the demo moves days forward
  "GET /sim/clock": () => [200, { date: db.clock, scheduled: db.scheduled.length }],
  "POST /sim/advance": async (req, body) => {
    if (!same(req.headers["x-effects-token"], EFFECTS_TOKEN)) return [401, { error: "только шлюз и стенд" }];
    const done = sim.advance(Number(body.days ?? 1));
    await save();
    return [200, { date: db.clock, delivered: done }];
  },
};

// Open routes: reads (except the banks) and the demo's letters from outside.
const open = (method, path) =>
  (method === "GET" && !/^\/(tbank|bankb)\//.test(path)) || ["/mail/incoming", "/mail/take"].includes(path);
const bank = (path) => /^\/(tbank|bankb)\//.test(path);

createServer(async (req, res) => {
  const url = new URL(req.url, "http://fin");
  const route =
    routes[`${req.method} ${url.pathname}`] ??
    (req.method === "GET" && url.pathname.startsWith("/ledger1c/odata/") ? "odata" : null);
  let status = 404,
    body = { error: "not found" },
    type = "application/json; charset=utf-8";
  try {
    if (route) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : {};
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (bank(url.pathname) && !same(auth, BANK_TOKEN)) [status, body] = [401, { errorMessage: "Unauthorized" }];
      else if (
        !bank(url.pathname) &&
        !open(req.method, url.pathname) &&
        url.pathname !== "/sim/advance" &&
        !same(req.headers["x-effects-token"], EFFECTS_TOKEN)
      )
        [status, body] = [401, { error: "writes go through the effect gateway" }];
      else if (route === "odata") {
        const entity = decodeURIComponent(url.pathname.slice("/ledger1c/odata/".length));
        [status, body] = [200, { value: query(ledgerSet(entity), url.searchParams) }];
      } else [status, body, type = type] = await route(req, input, url);
    }
  } catch (error) {
    [status, body] = [400, { error: String(error.message ?? error) }];
  }
  res.writeHead(status, { "content-type": type });
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}).listen(PORT, "127.0.0.1");
