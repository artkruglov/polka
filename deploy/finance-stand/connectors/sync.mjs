// Direct connections of a company (fin.mjs sync, M7): each source fetches
// what is new since the last run and lays it into the company's folder in
// the same shape as the exports a bookkeeper hands over, so the audit reads
// one folder whether a file came by hand or by a connector. Files a person
// put there are never touched; a connector writes only its own.
//
//   /etc/finance/companies/<name>.json   the sources: addresses and options, no secrets
//   OpenBao finance/companies/<name>/<id>   each source's credentials, put there by the company
//   /var/lib/finance/companies/<name>/
//     exports/      what the audit reads: hand-made files and the connectors' ones
//     state.json    where each source stopped: the last date, the last UID
//     sync.jsonl    one line per run: what came, what failed
//
// Sources, read only every one:
//   tbank    T-Business T-API: accounts and statements → «Т-Банк <счёт>.json»
//   odata1c  1C's standard OData: counterparties, invoices, receipts, sales → «1С OData.json»
//   imap     the box for documents → «Почта <ящик>.mbox»
// A source that fails leaves its last files as they were and says why; the
// others go on.
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as tbank from "../adapters/tbank.mjs";
import { mboxEntry } from "../imports/mail.mjs";
import { fetchNew } from "./imap.mjs";
import { readLedger } from "./odata1c.mjs";

const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const json = (x) => JSON.stringify(x, null, 1);

async function put(file, bytes) {
  await writeFile(`${file}.part`, bytes, { mode: 0o600 });
  await rename(`${file}.part`, file);
}
const readJson = (file, fallback) => readFile(file, "utf8").then(JSON.parse, () => fallback);

export const SOURCES = {
  // The statement of each account from where the last run stopped; the last
  // day again, since the bank may add to it, merged by operationId.
  async tbank(src, { secret, state, exports, period }) {
    const base = src.base ?? "https://business.tbank.ru/openapi";
    const accounts = (await tbank.accounts({ base, token: secret.token }))
      .map((a) => a.accountNumber)
      .filter((a) => !src.accounts || src.accounts.includes(a));
    const out = { new: 0, total: 0, files: [], accounts: {} };
    for (const account of accounts) {
      const file = join(exports, `Т-Банк ${account}.json`);
      const had = await readJson(file, []);
      const last = state.accounts?.[account];
      const from = last ?? period.from;
      const ops = await tbank.statement({ base, token: secret.token, account, from, to: period.to });
      const byId = new Map(had.map((o) => [o.operationId, o]));
      for (const o of ops) if (!byId.has(o.operationId)) (out.new++, byId.set(o.operationId, o));
      const all = [...byId.values()].sort((a, b) => String(a.operationDate).localeCompare(String(b.operationDate)));
      await put(file, json(all));
      out.total += all.length;
      out.files.push(file);
      const lastDay = all.map((o) => String(o.operationDate).slice(0, 10)).at(-1);
      out.accounts[account] = lastDay ?? from;
    }
    return { ...out, state: { accounts: { ...state.accounts, ...out.accounts } } };
  },

  // The ledger of the whole period each time: 1C documents change back in time.
  async odata1c(src, { secret, exports, period, now }) {
    const entities = await readLedger({
      base: src.base,
      user: secret.user,
      password: secret.password,
      ca: src.ca,
      from: period.from,
      to: period.to,
    });
    const file = join(exports, "1С OData.json");
    const before = await readJson(file, null);
    const count = (e) => Object.values(e ?? {}).reduce((s, rows) => s + rows.length, 0);
    await put(file, json({ source: "1c-odata", base: src.base, at: now.toISOString(), period, entities }));
    return {
      new: Math.max(0, count(entities) - count(before?.entities)),
      total: count(entities),
      files: [file],
      state: {},
    };
  },

  // New letters after the last UID, appended to one .mbox.
  async imap(src, { secret, state, exports }) {
    const file = join(exports, `Почта ${src.name ?? secret.user}.mbox`);
    const got = await fetchNew({
      url: src.url,
      user: secret.user,
      password: secret.password,
      mailbox: src.mailbox ?? "INBOX",
      ca: src.ca,
      after: state,
    });
    const again = state.uidvalidity !== undefined && got.uidvalidity !== state.uidvalidity;
    const entries = got.letters.map((l) => mboxEntry(l.bytes));
    if (again || state.uidvalidity === undefined) await put(file, Buffer.concat(entries));
    else if (entries.length) await appendFile(file, Buffer.concat(entries), { mode: 0o600 });
    const total = (state.uidvalidity === got.uidvalidity && !again ? (state.total ?? 0) : 0) + entries.length;
    return {
      new: entries.length,
      total,
      files: [file],
      note: again
        ? "сервер перенумеровал папку (UIDVALIDITY) — письма взяты заново"
        : got.more
          ? "писем больше, чем за один раз: остальные — в следующий"
          : "",
      state: { uidvalidity: got.uidvalidity, uid: got.uid, total },
    };
  },
};

/** One run over the company's sources. `secret(id)` gives a source's credentials. */
export async function sync({ config, root, secret, now = new Date() }) {
  const exports = join(root, "exports");
  await mkdir(exports, { recursive: true, mode: 0o700 });
  const stateFile = join(root, "state.json");
  const state = await readJson(stateFile, {});
  const period = {
    from: config.from,
    // «to» is exclusive, as T-API's; without it — up to today
    to: config.to ?? addDays(now.toISOString().slice(0, 10), 1),
  };
  const report = { company: config.name, at: now.toISOString(), period, sources: [] };
  for (const src of config.sources) {
    const at = Date.now();
    try {
      if (!SOURCES[src.kind]) throw new Error(`нет такого источника: ${src.kind}`);
      const r = await SOURCES[src.kind](src, {
        secret: await secret(src.id),
        state: state[src.id] ?? {},
        exports,
        period,
        now,
      });
      state[src.id] = { ...r.state, ok: now.toISOString() };
      report.sources.push({
        id: src.id,
        kind: src.kind,
        ok: true,
        new: r.new,
        total: r.total,
        note: r.note || undefined,
        ms: Date.now() - at,
      });
    } catch (error) {
      state[src.id] = { ...state[src.id], failed: now.toISOString() };
      report.sources.push({
        id: src.id,
        kind: src.kind,
        ok: false,
        error: String(error.message ?? error),
        last: state[src.id].ok ?? null,
        ms: Date.now() - at,
      });
    }
  }
  await put(stateFile, json(state));
  await appendFile(join(root, "sync.jsonl"), JSON.stringify(report) + "\n", { mode: 0o600 });
  return report;
}

const WHAT = { tbank: "Т-Банк", odata1c: "1С", imap: "почта" };
const UNIT = { tbank: "операций", odata1c: "записей", imap: "писем" };

/** The run as lines: they head the export passport of the audit after it. */
export function syncLines(r) {
  return [
    `Подключения ${r.company}, ${r.at.slice(0, 16).replace("T", " ")} UTC, период ${r.period.from} — ${r.period.to}:`,
    ...r.sources.map((s) =>
      s.ok
        ? `  ✓ ${WHAT[s.kind] ?? s.kind} (${s.id}): новых ${UNIT[s.kind] ?? "записей"} ${s.new}, всего ${s.total}${s.note ? ` · ${s.note}` : ""}`
        : `  ✗ ${WHAT[s.kind] ?? s.kind} (${s.id}): ${s.error} — в аудите данные ${s.last ? `на ${s.last.slice(0, 10)}` : "этого источника отсутствуют"}`,
    ),
  ];
}
