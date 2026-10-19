#!/usr/bin/env node
// Systems of record of the swarm stand (deploy/contour-stand/README.md,
// «Рой»): a ledger of operations, an EDO with a signing queue and a mail
// service. Each is an API only, with no screens for people: agents read it,
// the platform's effect gateway writes it. Runs as root in the VM on
// 127.0.0.1:7070; no dependencies.
//
// Reads (GET) are open on the VM's loopback; a sandbox reaches them only
// through Squid and only with GET (squid.conf, p_systems). Writes need the
// effect gateway's token, and every write takes an idempotency key: the same
// key returns the first result instead of a second invoice or letter.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const PORT = 7070;
const FILE = "/var/lib/contour/systems.json";
const TOKEN = readFileSync("/etc/contour/effects-token", "utf8").trim();

const empty = () => ({ invoices: [], payments: [], mailboxes: {}, outbox: [], edo: [], keys: {} });
let db = empty();
try {
  db = { ...empty(), ...JSON.parse(await readFile(FILE, "utf8")) };
} catch {}
const save = async () => {
  await mkdir("/var/lib/contour", { recursive: true });
  await writeFile(FILE, JSON.stringify(db, null, 1));
};
const id = (prefix) => `${prefix}-${randomBytes(3).toString("hex")}`;
const now = () => new Date().toISOString();

function authorized(req) {
  const given = Buffer.from(String(req.headers["x-effects-token"] ?? ""));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

// One write per idempotency key: a repeat returns the stored answer.
async function once(req, make) {
  const key = String(req.headers["idempotency-key"] ?? "");
  if (!key) return [400, { error: "idempotency-key is required" }];
  if (db.keys[key]) return [200, { ...db.keys[key], repeated: true }];
  const [status, body] = await make();
  if (status < 300) db.keys[key] = body;
  await save();
  return [status, body];
}

const routes = {
  // ---- ledger: invoices and payments, no UI
  "GET /ledger/invoices": () => [200, db.invoices],
  "GET /ledger/payments": () => [200, db.payments],
  "POST /ledger/invoices": (req, body) =>
    once(req, async () => {
      if (!body.counterparty || !(body.amount > 0)) return [422, { error: "counterparty and amount > 0" }];
      const inv = { id: id("inv"), state: "issued", created: now(), ...body };
      db.invoices.push(inv);
      return [201, inv];
    }),
  // Compensation: an issued invoice can be cancelled; that is why the policy
  // may let an invoice through without a person.
  "POST /ledger/cancel": (req, body) =>
    once(req, async () => {
      const inv = db.invoices.find((i) => i.id === body.id);
      if (!inv) return [404, { error: "no such invoice" }];
      inv.state = "cancelled";
      inv.cancelled = now();
      return [200, inv];
    }),

  // ---- mail: process mailboxes in, an outbox out
  "GET /mail/inbox": (req, _b, url) => {
    const box = url.searchParams.get("box");
    return [200, (db.mailboxes[box] ?? []).filter((m) => !url.searchParams.has("new") || !m.taken)];
  },
  // A letter from the outside world. Open on the loopback: the demo is the
  // outside world. Never reachable from a sandbox (GET only through Squid).
  "POST /mail/incoming": async (_req, body) => {
    const m = { id: id("msg"), at: now(), from: body.from, subject: body.subject, text: body.text, taken: false };
    (db.mailboxes[body.box] ??= []).push(m);
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
      const m = { id: id("out"), at: now(), ...body };
      db.outbox.push(m);
      return [201, m];
    }),

  // ---- EDO: a document waits in the queue until a person signs it
  "GET /edo/documents": () => [200, db.edo],
  "POST /edo/queue": (req, body) =>
    once(req, async () => {
      if (!body.sha256 || !body.revisionId) return [422, { error: "sha256 and revisionId" }];
      const d = { id: id("edo"), state: "awaiting_signature", queued: now(), ...body };
      db.edo.push(d);
      return [201, d];
    }),
  "POST /edo/sign": (req, body) =>
    once(req, async () => {
      const d = db.edo.find((x) => x.id === body.id);
      if (!d) return [404, { error: "no such document" }];
      if (d.state !== "awaiting_signature") return [409, { error: `document is ${d.state}` }];
      if (body.sha256 !== d.sha256) return [409, { error: "the signed bytes differ from the queued ones" }];
      Object.assign(d, { state: "sent", signedBy: body.signer, signed: now(), receipt: id("rcpt") });
      return [200, d];
    }),
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://systems");
  const route = routes[`${req.method} ${url.pathname}`];
  let status = 404,
    body = { error: "not found" };
  try {
    if (route) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : {};
      const open = req.method === "GET" || url.pathname === "/mail/incoming" || url.pathname === "/mail/take";
      if (!open && !authorized(req)) [status, body] = [401, { error: "writes go through the effect gateway" }];
      else [status, body] = await route(req, input, url);
    }
  } catch (error) {
    [status, body] = [400, { error: String(error.message ?? error) }];
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}).listen(PORT, "127.0.0.1");
