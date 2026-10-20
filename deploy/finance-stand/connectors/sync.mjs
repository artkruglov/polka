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
// others go on. A source's place is saved as soon as its files are, and one
// run of a company at a time holds sync.lock. A source whose file is gone or
// unreadable starts over from the beginning of the period.
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as tbank from "../adapters/tbank.mjs";
import { mboxEntry } from "../imports/mail.mjs";
import { fetchNew, size } from "./imap.mjs";
import { secureOnly } from "./net.mjs";
import { readLedger } from "./odata1c.mjs";

const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const json = (x) => JSON.stringify(x, null, 1);

async function put(file, bytes) {
  await writeFile(`${file}.part`, bytes, { mode: 0o600 });
  await rename(`${file}.part`, file);
}
const readJson = (file, fallback) => readFile(file, "utf8").then(JSON.parse, () => fallback);
const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

export const SOURCES = {
  // The statement of each account from where the last run stopped; the last
  // day again, since the bank may add to it, merged by operationId.
  async tbank(src, { secret, state, exports, period }) {
    const base = src.base ?? "https://business.tbank.ru/openapi";
    secureOnly(base, "http:");
    const opts = { base, token: secret.token, ca: src.ca };
    const accounts = (await tbank.accounts(opts))
      .map((a) => a.accountNumber)
      .filter((a) => !src.accounts || src.accounts.includes(a));
    const out = { new: 0, total: 0, files: [], accounts: {}, notes: [] };
    for (const account of accounts) {
      const file = join(exports, `Т-Банк ${account}.json`);
      const had = await readJson(file, null);
      const last = Array.isArray(had) && had.length ? state.accounts?.[account] : undefined;
      if (state.accounts?.[account] && !last)
        out.notes.push(`${account}: файла нет или он испорчен — выписка взята с начала периода`);
      const from = last ?? period.from;
      const ops = await tbank.statement({ ...opts, account, from, to: period.to });
      const byId = new Map((Array.isArray(had) ? had : []).map((o) => [o.operationId, o]));
      for (const o of ops) if (!byId.has(o.operationId)) (out.new++, byId.set(o.operationId, o));
      const all = [...byId.values()].sort((a, b) => String(a.operationDate).localeCompare(String(b.operationDate)));
      await put(file, json(all));
      out.total += all.length;
      out.files.push(file);
      const lastDay = all.map((o) => String(o.operationDate).slice(0, 10)).at(-1);
      out.accounts[account] = lastDay ?? from;
    }
    return { ...out, note: out.notes.join("; "), state: { accounts: { ...state.accounts, ...out.accounts } } };
  },

  // The ledger of the whole period each time: 1C documents change back in
  // time. What changed is told by Ref_Key and DataVersion.
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
    const versions = (e) =>
      new Map(
        Object.values(e ?? {}).flatMap((rows) => rows.map((r) => [r.Ref_Key, r.DataVersion ?? JSON.stringify(r)])),
      );
    const [was, is] = [versions(before?.entities), versions(entities)];
    const changed = [...is].filter(([k, v]) => was.get(k) !== v).length;
    const gone = [...was.keys()].filter((k) => !is.has(k)).length;
    await put(file, json({ source: "1c-odata", base: src.base, at: now.toISOString(), period, entities }));
    return {
      new: changed,
      total: is.size,
      files: [file],
      note: gone ? `исчезло с прошлого раза (удалено или распроведено): ${gone}` : "",
      state: {},
    };
  },

  // New letters after the last UID, appended to one .mbox.
  async imap(src, { secret, state, exports }) {
    const file = join(exports, `Почта ${src.name ?? secret.user}.mbox`);
    const fresh = state.uidvalidity === undefined || !(await exists(file));
    const got = await fetchNew({
      url: src.url,
      user: secret.user,
      password: secret.password,
      mailbox: src.mailbox ?? "INBOX",
      ca: src.ca,
      after: fresh ? {} : state,
      ...(src.maxLetter ? { maxLetter: src.maxLetter } : {}),
    });
    const again = !fresh && got.uidvalidity !== state.uidvalidity;
    const entries = got.letters.filter((l) => l.bytes).map((l) => mboxEntry(l.bytes));
    if (fresh || again) await put(file, Buffer.concat(entries));
    else if (entries.length) await appendFile(file, Buffer.concat(entries), { mode: 0o600 });
    const total = (fresh || again ? 0 : (state.total ?? 0)) + entries.length;
    const big = got.letters.filter((l) => !l.bytes);
    const notes = [
      again ? "сервер перенумеровал папку (UIDVALIDITY) — письма взяты заново" : "",
      fresh && state.uidvalidity !== undefined ? "файла почты нет — письма взяты заново" : "",
      big.length
        ? `не взяты письма больше ${size(big[0].limit)}: UID ${big.map((l) => l.uid).join(", ")} — их документы нужно положить в папку руками`
        : "",
      got.more ? "писем больше, чем за один раз: остальные — в следующий" : "",
    ];
    return {
      new: entries.length,
      total,
      files: [file],
      note: notes.filter(Boolean).join("; "),
      state: { uidvalidity: got.uidvalidity, uid: got.uid, total },
    };
  },
};

// One run of a company at a time: the timer and a person may start one together.
async function lock(root) {
  const file = join(root, "sync.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await open(file, "wx", 0o600);
      await h.write(String(process.pid));
      await h.close();
      return () => rm(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await readFile(file, "utf8").catch(() => ""));
      let alive = false;
      try {
        alive = pid > 0 && process.kill(pid, 0);
      } catch {}
      if (alive) throw new Error(`синхронизация этой компании уже идёт (процесс ${pid})`);
      await rm(file, { force: true }); // left by a run that died
    }
  }
  throw new Error("не взял sync.lock");
}

/** One run over the company's sources. `secret(id)` gives a source's credentials. */
export async function sync({ config, root, secret, now = new Date() }) {
  const exports = join(root, "exports");
  await mkdir(exports, { recursive: true, mode: 0o700 });
  const unlock = await lock(root);
  try {
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
      // saved right after the source's files: a run that dies later does not take them twice
      await put(stateFile, json(state));
    }
    await appendFile(join(root, "sync.jsonl"), JSON.stringify(report) + "\n", { mode: 0o600 });
    return report;
  } finally {
    await unlock();
  }
}

const WHAT = { tbank: "Т-Банк", odata1c: "1С", imap: "почта" };
const UNIT = { tbank: "новых операций", odata1c: "новых или изменённых записей", imap: "новых писем" };

/** The run as lines: they head the export passport of the audit after it. */
export function syncLines(r) {
  return [
    `Подключения ${r.company}, ${r.at.slice(0, 16).replace("T", " ")} UTC, период ${r.period.from} — ${r.period.to}:`,
    ...r.sources.map((s) =>
      s.ok
        ? `  ✓ ${WHAT[s.kind] ?? s.kind} (${s.id}): ${UNIT[s.kind] ?? "новых записей"} ${s.new}, всего ${s.total}${s.note ? ` · ${s.note}` : ""}`
        : `  ✗ ${WHAT[s.kind] ?? s.kind} (${s.id}): ${s.error} — в аудите данные ${s.last ? `на ${s.last.slice(0, 10)}` : "этого источника отсутствуют"}`,
    ),
  ];
}
