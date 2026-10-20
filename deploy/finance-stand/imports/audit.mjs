// A company's exports as fin-match's inputs (fin.mjs audit), and the export
// passport: what each file was taken for, what is missing, whether the banks'
// own totals add up. The files are whatever the bookkeeper hands over:
//   *.txt    1CClientBankExchange from any bank, Windows or DOS
//   *.json   a T-API statement ({operations: [...]}) or a list of its operations;
//            «1С OData.json» — the ledger as the 1C connector took it (connectors/odata1c.mjs)
//   *.xlsx / *.csv   1C lists (invoices to clients and from suppliers, receipts,
//            sales, counterparties), EDO registries, the stand's own layouts
//   *.mbox / *.eml   a mailbox export: the UPDs suppliers outside EDO attach to letters
//   *.xml    a UPD in the FNS format, loose or from a letter
//   *.pdf, scans     not guessed at without a model: the passport names them
//   firm.json  {"inn", "name", "asOf"} — optional: the firm is read off the bank files
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { statementOf } from "../adapters/clientbank.mjs";
import { normalize } from "../adapters/tbank.mjs";
import { tablesOf } from "../connectors/odata1c.mjs";
import { readEml, readMbox } from "./mail.mjs";
import { amount, date, nameKey, readTable } from "./tables.mjs";
import { readUpdXml } from "./upd-xml.mjs";

const SCAN = /\.(pdf|jpe?g|png|tiff?|heic|bmp)$/i;

const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const cents = (x) => Math.round(x * 100);
const money = (x) => x.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// What a registry calls a document; Акт and ТОРГ-12 close the line as a UPD does.
const edoKind = (s) => {
  const k = String(s ?? "").toLowerCase();
  if (/сверк|recon/.test(k)) return "recon";
  if (/упд|универсальн|upd|торг|накладн|акт|act/.test(k)) return "upd";
  if (/сч[её]т[- ]?фактур|счф/.test(k)) return "vat_invoice";
  if (/сч[её]т|invoice/.test(k)) return "invoice";
  return k || "upd";
};
const edoStatus = (s) =>
  /отказ|отклон|аннулир|reject/i.test(s) ? "rejected" : /заверш|подписан|signed/i.test(s) ? "signed" : "awaiting";

export async function readExports(dir, { asOf, terms = 10 } = {}) {
  // a connector's half-written file (.part) and anything hidden are not exports
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && !e.name.startsWith(".") && !e.name.endsWith(".part"))
    .map((e) => e.name)
    .sort();
  const passport = { files: [], banks: [], warnings: [], firm: null };
  const warn = (w) => passport.warnings.push(w);
  const tables = { contractors: [], invoices: [], receipts: [], sales: [], edo: [] };
  const operations = [];
  const mail = { letters: 0, attachments: 0, upd: [], copies: 0, unread: [], skipped: [] };
  // a document file, loose in the folder or attached to a letter
  const take = (name, bytes, where) => {
    if (/\.xml$/i.test(name)) {
      const u = readUpdXml(bytes);
      if (u) return void mail.upd.push({ ...u, where });
      mail.skipped.push(`${where}: XML не УПД`);
    } else if (SCAN.test(name)) mail.unread.push(where);
    else mail.skipped.push(`${where}: ${name.split(".").pop() || "без расширения"} не беру`);
  };
  let firm = null;
  const seen = new Set();
  let duplicates = 0;
  // The banks' files, added after the loop: an account in a T-API file (the
  // connector's, as a rule) is not taken a second time from a «Клиент-банк» file.
  const bankSets = [];
  let odata = null;
  const addOps = (ops) => {
    for (const op of ops) {
      // the same day exported twice, or two overlapping statements
      const key = [op.ourAccount ?? op.bank, op.date, op.direction, op.amount, op.docNo, op.inn].join("|");
      if (seen.has(key)) duplicates++;
      else (seen.add(key), operations.push(op));
    }
  };

  for (const n of names) {
    const bytes = await readFile(join(dir, n));
    const stem = n.replace(/\.[^.]+$/, "");
    if (n === "firm.json") {
      firm = JSON.parse(bytes.toString("utf8"));
      passport.files.push({ file: n, kind: "firm", how: "имя файла", rows: 1 });
    } else if (/\.txt$/i.test(n)) {
      let s;
      try {
        s = statementOf(bytes, stem);
      } catch (e) {
        passport.files.push({ file: n, kind: null, why: e.message });
        continue;
      }
      bankSets.push({ file: n, tapi: false, ops: s.operations });
      passport.files.push({ file: n, kind: "bank", how: "1CClientBankExchange", rows: s.operations.length });
      for (const account of s.accounts) {
        const mine = s.operations.filter((o) => o.ourAccount === account);
        const got = {
          income: mine.filter((o) => o.direction === "in").reduce((t, o) => t + cents(o.amount), 0) / 100,
          outcome: mine.filter((o) => o.direction === "out").reduce((t, o) => t + cents(o.amount), 0) / 100,
        };
        const b = s.balances.find((x) => x.account === account);
        let check = "банк не выгрузил итоги (СекцияРасчСчет)";
        if (b && b.income !== null && b.outcome !== null) {
          const lost = cents(b.income) !== cents(got.income) || cents(b.outcome) !== cents(got.outcome);
          const rest =
            b.opening !== null && b.closing !== null && cents(b.opening + b.income - b.outcome) !== cents(b.closing);
          check = lost
            ? `не сходится: банк насчитал поступлений ${money(b.income)} и списаний ${money(b.outcome)}, в документах ${money(got.income)} и ${money(got.outcome)}`
            : rest
              ? "не сходится остаток: начальный + поступления − списания ≠ конечный"
              : "сходится";
          if (check !== "сходится") warn(`${n}, счёт ${account}: ${check}`);
        }
        passport.banks.push({
          file: n,
          account,
          encoding: s.encoding,
          from: b?.from ?? s.from,
          to: b?.to ?? s.to,
          operations: mine.length,
          check,
        });
      }
      if (s.firm) firm ??= { ...s.firm, source: n };
    } else if (/\.json$/i.test(n)) {
      const j = JSON.parse(bytes.toString("utf8"));
      if (j?.source === "1c-odata") {
        const t = tablesOf(j.entities);
        odata = { file: n, ...t, invoices: t.invoices.map((r) => ({ ...r, file: n })) };
        passport.files.push({
          file: n,
          kind: "ledger",
          how: `OData 1С на ${String(j.at).slice(0, 10)}: контрагентов ${t.contractors.length}, счетов ${t.invoices.length}, поступлений ${t.receipts.length}, реализаций ${t.sales.length}`,
          rows: t.contractors.length + t.invoices.length + t.receipts.length + t.sales.length,
        });
        continue;
      }
      const raw = Array.isArray(j) ? j : (j.operations ?? []);
      const ops = raw.map((o) => ({
        ...normalize(o, stem),
        ourAccount: (o.typeOfOperation === "Credit" ? o.receiver?.acct : o.payer?.acct) || undefined,
      }));
      bankSets.push({ file: n, tapi: true, ops });
      const dates = ops.map((o) => o.date).sort();
      passport.files.push({ file: n, kind: "bank", how: "T-API", rows: ops.length });
      passport.banks.push({
        file: n,
        account:
          raw[0]?.receiver?.acct && raw[0]?.typeOfOperation === "Credit" ? raw[0].receiver.acct : raw[0]?.payer?.acct,
        encoding: "utf-8",
        from: dates[0],
        to: dates.at(-1),
        operations: ops.length,
        check: "T-API не отдаёт итогов: полноту проверьте по остаткам в банке",
      });
      const us = raw.find((o) => o.typeOfOperation === "Debit")?.payer;
      if (us?.inn) firm ??= { inn: us.inn, name: us.name, source: n };
    } else if (/\.(xlsx|csv|tsv)$/i.test(n)) {
      const t = readTable(n, bytes);
      if (!t.kind) {
        passport.files.push({ file: n, kind: null, why: t.why });
        continue;
      }
      passport.files.push({
        file: n,
        kind: t.kind,
        how: t.how,
        rows: t.rows.length,
        columns: t.columns,
        missing: t.missing,
      });
      const side = t.kind === "invoices_ap" ? "ap" : t.kind === "invoices_ar" ? "ar" : null;
      const dirOfFile = /входящ|incoming|\bin\b/i.test(n) ? "in" : /исходящ|outgoing|\bout\b/i.test(n) ? "out" : null;
      for (const r of t.rows) {
        if (t.kind.startsWith("invoices"))
          tables.invoices.push({ ...r, side: side ?? r.side, file: n, noDue: !("due" in t.columns) });
        else if (t.kind === "edo") tables.edo.push({ ...r, dir: r.dir || dirOfFile, file: n });
        else tables[t.kind].push(r);
      }
    } else if (/\.(mbox|eml)$/i.test(n)) {
      const letters = /\.eml$/i.test(n) ? [readEml(bytes)] : readMbox(bytes);
      mail.letters += letters.length;
      for (const l of letters) {
        // a PDF beside a UPD's XML in one letter is its printed copy
        const hasXml = l.attachments.some((a) => /\.xml$/i.test(a.name) && readUpdXml(a.bytes));
        for (const a of l.attachments) {
          mail.attachments++;
          const where = `${n} · «${l.subject}» от ${l.from} · ${a.name}`;
          if (hasXml && SCAN.test(a.name)) mail.copies++;
          else take(a.name, a.bytes, where);
        }
      }
      passport.files.push({ file: n, kind: "mail", how: "почта", rows: letters.length });
    } else if (/\.xml$/i.test(n) || SCAN.test(n)) {
      mail.attachments++;
      take(n, bytes, n);
      passport.files.push({ file: n, kind: "document", how: /\.xml$/i.test(n) ? "XML" : "скан", rows: 1 });
    } else passport.files.push({ file: n, kind: null, why: "формат не читаю: сохраните как .xlsx или .csv" });
  }
  const viaApi = new Map();
  for (const b of bankSets.filter((x) => x.tapi)) for (const o of b.ops) if (o.ourAccount) viaApi.set(o.ourAccount, b.file);
  for (const b of bankSets) {
    const twice = b.tapi ? new Set() : new Set(b.ops.map((o) => o.ourAccount).filter((a) => viaApi.has(a)));
    for (const a of twice)
      warn(`${b.file}: счёт ${a} есть и в ${viaApi.get(a)} — операции по нему взяты оттуда, из этого файла не считаются`);
    addOps(b.ops.filter((o) => !twice.has(o.ourAccount)));
  }
  // 1C's OData is the whole ledger: lists exported by hand beside it would count twice
  if (odata) {
    const hand = passport.files.filter((f) => ["invoices_ar", "invoices_ap", "invoices", "receipts", "sales"].includes(f.kind));
    if (hand.length)
      warn(`списки 1С ${hand.map((f) => f.file).join(", ")} не взяты: счета, поступления и реализации взяты из ${odata.file}`);
    tables.invoices = odata.invoices;
    tables.receipts = odata.receipts;
    tables.sales = odata.sales;
    tables.contractors.push(...odata.contractors);
  }
  if (duplicates)
    warn(`операций, выгруженных дважды (тот же счёт, дата, сумма, номер): ${duplicates} — посчитаны один раз`);

  // ---- the firm and the date of the audit
  if (!firm?.inn) throw new Error("не нашёл ИНН фирмы: положите выписку банка или firm.json {inn, name, asOf}");
  const ends = passport.banks
    .map((b) => b.to)
    .filter(Boolean)
    .sort();
  firm.asOf = asOf ?? firm.asOf ?? ends.at(-1);
  passport.firm = { inn: firm.inn, name: firm.name, asOf: firm.asOf, source: firm.source ?? "firm.json" };
  for (const b of passport.banks)
    if (b.to && b.to < firm.asOf)
      warn(`${b.file}: выписка кончается ${b.to}, а сверка на ${firm.asOf} — оплаты после ${b.to} не видны`);

  // ---- counterparties: INN by name, from the list, the banks and EDO
  const byName = new Map();
  const learn = (name, inn, extra = {}) => {
    const k = nameKey(name);
    if (k && inn && !byName.has(k)) byName.set(k, { inn: String(inn), name: String(name).trim(), ...extra });
  };
  for (const c of tables.contractors) learn(c.name, c.inn, { kpp: c.kpp, email: c.email });
  for (const d of tables.edo) learn(d.counterparty, d.inn);
  for (const o of operations) learn(o.name, o.inn);
  const innOf = (r) => (r.inn ? String(r.inn).trim() : (byName.get(nameKey(r.counterparty))?.inn ?? ""));
  const cps = new Map();
  const unknown = new Set();
  const cpKey = (r) => {
    const inn = innOf(r);
    if (!inn) {
      unknown.add(String(r.counterparty).trim());
      return null;
    }
    if (!cps.has(inn)) {
      const known = [...byName.values()].find((c) => c.inn === inn);
      cps.set(inn, { Ref_Key: `cp-${inn}`, Description: known?.name ?? String(r.counterparty).trim(), ИНН: inn });
    }
    return `cp-${inn}`;
  };

  // ---- invoices
  const sides = { ap: [], ar: [] };
  let defaultDue = 0;
  for (const r of tables.invoices) {
    const side = /ap|поставщ|входящ/i.test(r.side) ? "ap" : /ar|покуп|исходящ/i.test(r.side) ? "ar" : null;
    const key = cpKey(r);
    if (!side || !key) continue;
    const d = date(r.date);
    if (!r.due) defaultDue++;
    sides[side].push({
      Number: String(r.number).trim(),
      ...(r.incoming ? { НомерВходящегоДокумента: String(r.incoming).trim() } : {}),
      Date: d,
      Контрагент_Key: key,
      СуммаДокумента: amount(r.amount),
      СрокОплаты: r.due ? date(r.due) : addDays(d, terms),
      Posted: true,
    });
  }
  if (defaultDue) warn(`у ${defaultDue} счетов нет срока оплаты — считаю ${terms} дней от даты счёта (--terms)`);

  // ---- receipts and sales: what was posted in the ledger
  const ledgerDoc = (r) => ({
    ...(r.number ? { Number: String(r.number).trim() } : {}),
    ...(r.incoming ? { НомерВходящегоДокумента: String(r.incoming).trim() } : {}),
    ...(r.basis ? { ДокументОснование: String(r.basis).trim() } : {}),
    ...(r.counterparty || r.inn ? { Контрагент_Key: cpKey(r) } : {}),
    ...(r.date ? { Date: date(r.date) } : {}),
    СуммаДокумента: amount(r.amount),
    Posted: true,
  });

  // ---- EDO
  const supplierInn = new Set(sides.ap.map((d) => d.Контрагент_Key));
  let guessedDir = 0;
  const edo = tables.edo.map((d, k) => {
    const inn = innOf(d);
    let dir = /вход|^in/i.test(d.dir) ? "in" : /исход|^out/i.test(d.dir) ? "out" : null;
    if (!dir) {
      guessedDir++;
      dir = supplierInn.has(`cp-${inn}`) ? "in" : "out";
    }
    const vat = d.vat === undefined || d.vat === "" ? null : amount(d.vat);
    return {
      id: `edo-${k + 1}`,
      kind: edoKind(d.kind),
      dir,
      inn,
      counterparty: String(d.counterparty ?? "").trim(),
      number: String(d.number).trim(),
      date: date(d.date),
      amount: amount(d.amount),
      vat: Number.isNaN(vat) ? null : vat,
      basis: String(d.basis ?? "").trim(),
      status: edoStatus(d.status ?? ""),
    };
  });
  // ---- UPDs from mail: the counterparty is the side that is not the firm;
  // one that also came through EDO counts once
  const inEdo = new Set(edo.map((d) => `${d.inn}|${d.number}`));
  let twice = 0;
  for (const u of mail.upd) {
    const out = u.seller?.inn === firm.inn;
    const other = out ? u.buyer : u.seller;
    if (!other?.inn) continue;
    if (inEdo.has(`${other.inn}|${u.number}`)) {
      twice++;
      continue;
    }
    inEdo.add(`${other.inn}|${u.number}`);
    edo.push({
      id: `mail-${edo.length + 1}`,
      kind: "upd",
      dir: out ? "out" : "in",
      inn: other.inn,
      counterparty: other.name,
      number: u.number,
      date: u.date,
      amount: u.amount,
      vat: u.vat,
      basis: u.basis,
      status: "signed",
      source: u.where,
    });
  }
  passport.mail = {
    letters: mail.letters,
    attachments: mail.attachments,
    upd: mail.upd.length,
    twice,
    copies: mail.copies,
    unread: mail.unread,
    skipped: mail.skipped,
  };
  if (mail.unread.length)
    warn(
      `вложений без текста для разбора (PDF, сканы): ${mail.unread.length} — без модели не читаю, их счета остаются в хвостах: ${mail.unread.slice(0, 3).join("; ")}${mail.unread.length > 3 ? "…" : ""}`,
    );
  if (guessedDir) warn(`у ${guessedDir} документов ЭДО нет направления — понял по контрагенту (поставщик — входящий)`);
  if (!edo.length)
    warn("нет реестра ЭДО: линия документов не проверяется, все оплаченные счета поставщиков будут «нет УПД»");
  if (!tables.receipts.length && !tables.sales.length)
    warn("нет поступлений и реализаций из учёта: «учёт ≠ ЭДО» не проверяется");
  if (!sides.ap.length && !sides.ar.length) warn("нет счетов: обязательств не из чего строить");
  if (unknown.size)
    warn(
      `не нашёл ИНН по наименованию (${unknown.size}): ${[...unknown].slice(0, 5).join("; ")}${unknown.size > 5 ? "…" : ""} — добавьте список контрагентов с ИНН`,
    );
  const first = [...sides.ap, ...sides.ar].map((d) => d.Date).sort()[0];
  const bankFrom = passport.banks
    .map((b) => b.from)
    .filter(Boolean)
    .sort()[0];
  if (first && bankFrom && first >= bankFrom)
    warn(
      `счета начинаются ${first}, выписка — ${bankFrom}: оплаты по счетам прошлого периода останутся без счёта; выгрузите счета на квартал раньше`,
    );

  const inputs = {
    operations: operations.map(({ ourAccount, ...op }) => op),
    edo,
    ledger: {
      Catalog_Контрагенты: [...cps.values()],
      Document_СчетНаОплатуПоставщика: sides.ap,
      Document_СчетНаОплатуПокупателю: sides.ar,
      Document_ПоступлениеТоваровУслуг: tables.receipts.map(ledgerDoc),
      Document_РеализацияТоваровУслуг: tables.sales.map(ledgerDoc),
    },
    firm: { inn: firm.inn, name: firm.name, asOf: firm.asOf },
  };
  passport.totals = {
    operations: inputs.operations.length,
    invoices: { ap: sides.ap.length, ar: sides.ar.length },
    edo: edo.length,
    primary: edo.filter((d) => d.kind === "upd").length,
    fromMail: edo.filter((d) => d.source).length,
    receipts: tables.receipts.length,
    sales: tables.sales.length,
    counterparties: cps.size,
  };
  return { inputs, passport };
}

const KIND_RU = {
  bank: "выписка",
  firm: "фирма",
  contractors: "контрагенты",
  invoices_ar: "счета покупателям",
  invoices_ap: "счета поставщиков",
  invoices: "счета",
  receipts: "поступления",
  sales: "реализации",
  edo: "реестр ЭДО",
  ledger: "учёт 1С",
  mail: "почта",
  document: "документ",
};

/** The passport as lines for a terminal or a page. */
export function passportLines(p) {
  const out = [
    `Фирма: ${p.firm.name ?? "—"}, ИНН ${p.firm.inn} (${p.firm.source}); сверка на ${p.firm.asOf}`,
    "",
    "Файлы:",
  ];
  for (const f of p.files) {
    if (!f.kind) {
      out.push(`  ✗ ${f.file}: ${f.why}`);
      continue;
    }
    const cols = f.columns
      ? ` · ${Object.entries(f.columns)
          .map(([k, h]) => `${k}←«${h}»`)
          .join(", ")}`
      : "";
    const miss = f.missing?.length ? ` · нет: ${f.missing.join(", ")}` : "";
    out.push(`  ✓ ${f.file}: ${KIND_RU[f.kind] ?? f.kind} (${f.how}), строк ${f.rows}${cols}${miss}`);
  }
  out.push("", "Банки:");
  for (const b of p.banks)
    out.push(
      `  ${b.account ?? "?"} ${b.from ?? "?"} — ${b.to ?? "?"}, операций ${b.operations}, ${b.encoding}: ${b.check}`,
    );
  const t = p.totals;
  out.push(
    "",
    `Итого: операций ${t.operations}, счетов поставщиков ${t.invoices.ap}, покупателям ${t.invoices.ar}, документов ЭДО ${t.edo} (первичных ${t.primary}), поступлений ${t.receipts}, реализаций ${t.sales}, контрагентов ${t.counterparties}`,
  );
  if (p.mail?.letters || p.mail?.attachments) {
    const m = p.mail;
    out.push(
      "",
      `Почта: писем ${m.letters}, вложений ${m.attachments}, УПД в XML ${m.upd} (уже были в ЭДО ${m.twice}, в сверку ${t.fromMail}), печатных форм рядом с XML ${m.copies}; без модели не прочитано ${m.unread.length}`,
      ...m.unread.map((w) => `  ? ${w}`),
      ...m.skipped.map((w) => `  · ${w}`),
    );
  }
  if (p.warnings.length) out.push("", "Внимание:", ...p.warnings.map((w) => `  ! ${w}`));
  return out;
}
