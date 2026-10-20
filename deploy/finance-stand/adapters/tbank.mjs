// T-Business bank adapter (deploy/finance-stand/README.md): the T-API
// statement and accounts, read by the coordinator and never by a sandbox,
// turned into the stand's operation shape. The same code reads the stand's
// bank (fin-systems, /tbank) and the bank's public sandbox
// (business.tbank.ru/openapi/sandbox); only the base address and the token
// differ.
//
// The bank's certificates chain to the Russian Trusted Root CA (the
// Ministry of Digital Development). Node does not trust it by default; the
// adapter takes that root from a file for its own requests only
// (FIN_TBANK_CA or /etc/finance/russian-trusted-root.pem) and changes
// nothing else's trust.
import { request } from "node:https";
import { readFile } from "node:fs/promises";
import { secureOnly } from "../connectors/net.mjs";

export const SANDBOX = "https://business.tbank.ru/openapi/sandbox";
export const MCP_SANDBOX = "https://mcp.tbank.ru/sandbox/b2b";
export const SANDBOX_TOKEN = "TBankSandboxToken"; // published by the bank for its sandbox
const CA_FILE = process.env.FIN_TBANK_CA ?? "/etc/finance/russian-trusted-root.pem";
// The fields the stand reads from an operation; the contract check looks for them.
export const NEEDED = [
  "operationId",
  "operationDate",
  "typeOfOperation",
  "accountAmount",
  "payPurpose",
  "counterParty",
];

export const ca = () => readFile(CA_FILE, "utf8").catch(() => null);

/** GET or POST over HTTPS (with the bank's root, or a company's own `ca`
 *  file) or plain HTTP to this machine only (the stand): a token never goes
 *  out in clear text. */
export async function call(url, { method = "GET", headers = {}, body, ca: caFile } = {}) {
  const u = secureOnly(url, "http:");
  if (u.protocol === "http:") {
    const r = await fetch(u, {
      method,
      headers,
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    return { status: r.status, headers: Object.fromEntries(r.headers), text, json: parse(text) };
  }
  const root = caFile ? await readFile(caFile, "utf8") : await ca();
  return new Promise((resolve, reject) => {
    const req = request(u, { method, headers, ...(root ? { ca: root } : {}), timeout: 20_000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: parse(text) }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) =>
      reject(
        new Error(
          e.code === "SELF_SIGNED_CERT_IN_CHAIN" && !root
            ? "нет корня Минцифры (fin.sh tbank-ca)"
            : (e.code ?? e.message),
        ),
      ),
    );
    if (body) req.end(typeof body === "string" ? body : JSON.stringify(body));
    else req.end();
  });
}
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const auth = (token) => ({ authorization: `Bearer ${token}`, accept: "application/json" });

export async function accounts({ base, token, ca }) {
  const r = await call(`${base}/api/v4/bank-accounts`, { headers: auth(token), ca });
  if (r.status !== 200) throw new Error(`банк: счета → ${r.status} ${r.text.slice(0, 160)}`);
  return r.json;
}

/** Every operation of an account for a period. The sandbox returns the same
 *  page and cursor forever, so a repeated cursor ends the loop too. */
export async function statement({ base, token, ca, account, from, to, limit = 1000, maxPages = 50 }) {
  const out = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ accountNumber: account, from: `${from}T00:00:00Z`, limit: String(limit) });
    if (to) q.set("to", `${to}T00:00:00Z`);
    if (cursor) q.set("cursor", cursor);
    const r = await call(`${base}/api/v1/statement?${q}`, { headers: auth(token), ca });
    if (r.status !== 200) throw new Error(`банк: выписка → ${r.status} ${r.text.slice(0, 160)}`);
    const ops = r.json.operations ?? [];
    out.push(...ops);
    cursor = r.json.nextCursor;
    if (!cursor || !ops.length || seen.has(cursor)) break;
    seen.add(cursor);
  }
  // The same operation may come twice across pages of the sandbox.
  return [...new Map(out.map((o) => [o.operationId, o])).values()];
}

/** The stand's operation: one shape for every bank. */
export function normalize(op, bank = "a") {
  const incoming = op.typeOfOperation === "Credit";
  const cp = op.counterParty ?? (incoming ? op.payer : op.receiver) ?? {};
  return {
    bank,
    opId: op.operationId,
    date: String(op.operationDate ?? op.docDate).slice(0, 10),
    amount: Number(op.accountAmount ?? op.operationAmount),
    direction: incoming ? "in" : "out",
    inn: cp.inn ?? "",
    name: cp.name ?? "",
    account: cp.account ?? cp.acct ?? "",
    purpose: op.payPurpose ?? op.description ?? "",
    docNo: op.documentNumber ?? "",
  };
}

/** Fields the stand needs that an operation lacks. */
export function missing(op) {
  const gaps = NEEDED.filter((f) => op[f] === undefined || op[f] === null);
  if (op.counterParty && !("inn" in op.counterParty)) gaps.push("counterParty.inn");
  if (op.counterParty && !("name" in op.counterParty)) gaps.push("counterParty.name");
  return gaps;
}

/** The MCP server's tool names: initialize, then tools/list (streamable HTTP). */
export async function mcpTools({ url = MCP_SANDBOX, token = SANDBOX_TOKEN } = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const init = await call(url, {
    method: "POST",
    headers,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "finance-stand", version: "1" } },
    },
  });
  if (init.status !== 200) throw new Error(`MCP: initialize → ${init.status}`);
  const session = init.headers["mcp-session-id"];
  const h = { ...headers, ...(session ? { "mcp-session-id": session } : {}) };
  await call(url, { method: "POST", headers: h, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  const list = await call(url, { method: "POST", headers: h, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
  // The answer may come as an event stream: take the data line with the result.
  const data = list.json ?? parse((list.text.match(/^data: (.*)$/m) ?? [])[1] ?? "");
  return (data?.result?.tools ?? []).map((t) => ({ name: t.name, readOnly: Boolean(t.annotations?.readOnlyHint) }));
}
