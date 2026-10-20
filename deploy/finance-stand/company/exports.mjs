// The synthetic firm as a bookkeeper hands it over for an audit (fin.mjs
// audit): 1C lists saved to Excel, an EDO registry in windows-1251 with title
// lines, «Клиент-банк» files in two encodings, no firm.json. A few things real
// data does are put in on purpose, none of them a tail, so the reference
// tails stay what they were:
//   - one client pays two invoices with one order («по счетам № …, …»);
//   - two suppliers number their invoices alike («№ 15»);
//   - one supplier is on the simplified system and sends UPDs without VAT;
//   - the ledger's lists carry names, not INNs; the counterparty list spells them out in full;
//   - suppliers outside EDO send their UPDs by mail as the FNS XML, some with a
//     printed PDF beside it; one sends only a scan, which an audit without a
//     model cannot read — that invoice stays a tail, and the reference says so;
//   - one supplier in EDO sends the same UPD by mail as well.
// Generated data only: real exports never go to git.
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VAT, clientBankExchange, cp1251, cp866, generate } from "./gen.mjs";
import { writeXlsx } from "../imports/xlsx.mjs";
import { writeEml, writeMbox } from "../imports/mail.mjs";
import { writeUpdXml } from "../imports/upd-xml.mjs";

const money = (x) => Math.round(x * 100) / 100;
const vatOf = (amount, rate = VAT) => money((amount * rate) / (100 + rate));
const serial = (iso) => Math.round((Date.parse(iso) - Date.UTC(1899, 11, 30)) / 864e5);
const ru = (iso) => iso.slice(0, 10).split("-").reverse().join(".");
const rub = (x) => x.toFixed(2).replace(".", ",");

/** A copy of the firm with the real-data quirks above; returns {firm, quirks}. */
export function realistic(c) {
  const f = structuredClone(c);
  const quirks = [];
  const byId = Object.fromEntries(f.counterparties.map((x) => [x.id, x]));
  const ops = () => [...f.bankA, ...f.bankB];
  const payOf = (o) =>
    ops().filter(
      (op) =>
        op.inn === byId[o.cp].inn &&
        op.purpose.includes(`№ ${o.number} `) &&
        op.direction === (o.side === "ap" ? "out" : "in"),
    );
  const plain = f.obligations.filter((o) => !o.tail);

  // one order for two invoices of a client
  const arByCp = Object.groupBy(
    plain.filter((o) => o.side === "ar" && payOf(o).length === 1),
    (o) => o.cp,
  );
  const pair = Object.values(arByCp).find((xs) => xs.length >= 2 && payOf(xs[0])[0].bank === payOf(xs[1])[0].bank);
  if (pair) {
    const [o1, o2] = pair;
    const [p1] = payOf(o1);
    const [p2] = payOf(o2);
    const list = p1.bank === "a" ? f.bankA : f.bankB;
    const amount = money(p1.amount + p2.amount);
    Object.assign(p1, {
      amount,
      date: p1.date > p2.date ? p1.date : p2.date,
      purpose: `Оплата по счетам № ${o1.number}, ${o2.number}, в т.ч. НДС ${VAT}% ${vatOf(amount).toFixed(2).replace(".", "-")}`,
    });
    list.splice(list.indexOf(p2), 1);
    quirks.push(`${byId[o1.cp].name} оплатил ${o1.number} и ${o2.number} одним платежом`);
  }

  // two suppliers' invoices both numbered «15»
  const ap = plain.filter((o) => o.side === "ap" && payOf(o).length === 1);
  const twins = [];
  for (const o of ap) if (twins.length < 2 && !twins.some((t) => t.cp === o.cp)) twins.push(o);
  for (const o of twins) {
    const [p] = payOf(o);
    p.purpose = p.purpose.replace(`№ ${o.number} `, "№ 15 ");
    o.incoming = "15";
    for (const d of f.edo) if (d.kind === "invoice" && d.basis === o.number) d.number = "15";
  }
  if (twins.length === 2)
    quirks.push(`${byId[twins[0].cp].name} и ${byId[twins[1].cp].name} выставили счета с одним номером «15»`);

  // a supplier on the simplified system: UPDs without VAT
  const tailed = new Set(f.obligations.filter((o) => o.tail).map((o) => o.cp));
  const usn = f.counterparties.find(
    (x) =>
      x.role === "supplier" &&
      !tailed.has(x.id) &&
      !twins.some((t) => t.cp === x.id) &&
      f.obligations.some((o) => o.cp === x.id),
  );
  if (usn) {
    for (const d of f.edo) if (d.inn === usn.inn) d.vat = 0;
    quirks.push(`${usn.name} на УСН: УПД без НДС`);
  }
  // UPDs of suppliers outside EDO come by mail
  const buyer = { inn: f.firm.inn, kpp: f.firm.kpp, name: f.firm.name };
  const byInn = Object.fromEntries(f.counterparties.map((x) => [x.inn, x]));
  const obOf = Object.fromEntries(f.obligations.map((o) => [o.number, o]));
  const letter = (d, attachments) => ({
    from: byInn[d.inn].email,
    to: f.firm.email,
    subject: `УПД по счёту ${d.basis}`,
    date: d.date,
    text: `Добрый день! Направляем УПД ${d.number} по счёту ${d.basis}. Оригинал отправим почтой России.`,
    attachments,
  });
  const xmlOf = (d) => {
    const cp = byInn[d.inn];
    const x = writeUpdXml({ ...d, seller: { inn: cp.inn, kpp: cp.kpp, name: cp.name }, buyer });
    return { name: x.name, type: "application/xml", bytes: x.bytes };
  };
  const pdf = (d) => ({
    name: `УПД ${d.number}.pdf`,
    type: "application/pdf",
    bytes: Buffer.from(`%PDF-1.4\n% УПД ${d.number}\n`),
  });
  f.mail = [];
  const byMail = f.edo.filter((d) => d.kind === "upd" && d.dir === "in" && !byInn[d.inn]?.edo);
  // the scan: an invoice that closes on both lines otherwise
  const scan = byMail.find((d) => !obOf[d.basis]?.tail);
  let sent = 0;
  byMail.forEach((d) => {
    if (d === scan)
      f.mail.push(
        letter(d, [{ name: "скан УПД.jpg", type: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) }]),
      );
    else f.mail.push(letter(d, sent++ % 2 ? [xmlOf(d)] : [xmlOf(d), pdf(d)]));
  });
  f.upds = f.edo.filter((d) => d.kind === "upd"); // the ledger's receipts still name them
  f.edo = f.edo.filter((d) => !byMail.includes(d));
  if (scan) {
    const o = obOf[scan.basis];
    const cp = byId[o.cp];
    f.expected.push([o.incoming ?? o.number, "ap", cp.name, cp.inn, "нет_упд", o.amount.toFixed(2)]);
    f.expected.sort((a, b) => a[0].localeCompare(b[0]));
  }
  const both = f.edo.find((d) => d.kind === "upd" && d.dir === "in" && byInn[d.inn]?.edo && !obOf[d.basis]?.tail);
  if (both) f.mail.push(letter(both, [xmlOf(both)]));
  if (byMail.length)
    quirks.push(
      `УПД поставщиков без ЭДО пришли почтой: ${byMail.length}, из них один скан; один УПД пришёл и через ЭДО, и письмом`,
    );
  return { firm: f, quirks };
}

const full = (name) =>
  name
    .replace(/^ООО /, "Общество с ограниченной ответственностью ")
    .replace(/^АО /, "Акционерное общество ")
    .replace(/^ИП /, "Индивидуальный предприниматель ");

const csv1251 = (lines) => cp1251(lines.map((l) => l.join(";")).join("\r\n") + "\r\n");

/** The files of the export folder; returns their names. */
export async function writeExports(c, dir) {
  await mkdir(dir, { recursive: true });
  const cps = Object.fromEntries(c.counterparties.map((x) => [x.id, x]));
  const byOb = Object.fromEntries(c.obligations.map((o) => [o.number, o]));
  const updOf = (number, dir) => (c.upds ?? c.edo).find((d) => d.kind === "upd" && d.basis === number && d.dir === dir);
  const files = {};
  const period = c.firm.period;

  files[`Выписка ${c.accounts.a.account}.txt`] = cp866(
    clientBankExchange(c.bankA, c.firm, c.accounts.a, period, { encoding: "DOS" }),
  );
  files[`Выписка ${c.accounts.b.account}.txt`] = cp1251(clientBankExchange(c.bankB, c.firm, c.accounts.b, period));

  files["Контрагенты.xlsx"] = writeXlsx([
    ["Наименование", "ИНН", "КПП", "Электронная почта"],
    ...c.counterparties.map((x) => [full(x.name), x.inn, x.kpp, x.email]),
  ]);

  // 1C «Вывести список»: the header in the first line, a total at the bottom
  const total = (docs) => money(docs.reduce((s, d) => s + d.СуммаДокумента, 0));
  const ar = c.ledger.Document_СчетНаОплатуПокупателю;
  files["Счета покупателям.xlsx"] = writeXlsx([
    ["Дата", "Номер", "Контрагент", "Сумма", "Срок оплаты"],
    ...ar.map((d) => [serial(d.Date), d.Number, cps[d.Контрагент_Key].name, d.СуммаДокумента, ru(d.СрокОплаты)]),
    ["", "", "", total(ar), ""],
  ]);
  const apDocs = c.ledger.Document_СчетНаОплатуПоставщика;
  files["Счета от поставщиков.xlsx"] = writeXlsx([
    ["Дата", "Номер", "Номер вх.", "Дата вх.", "Контрагент", "Сумма"],
    ...apDocs.map((d, i) => [
      serial(d.Date),
      `0000-${String(i + 1).padStart(6, "0")}`,
      byOb[d.Number]?.incoming ?? d.Number,
      ru(d.Date),
      cps[d.Контрагент_Key].name,
      d.СуммаДокумента,
    ]),
    ["", "", "", "", "", total(apDocs)],
  ]);
  files["Поступление (акты, накладные, УПД).xlsx"] = writeXlsx([
    ["Дата", "Номер", "Номер вх.", "Контрагент", "Сумма"],
    ...c.ledger.Document_ПоступлениеТоваровУслуг.map((d, i) => [
      `${ru(d.Date)} 0:00:00`,
      `0000-${String(i + 1).padStart(6, "0")}`,
      updOf(d.ДокументОснование, "in")?.number ?? "",
      cps[d.Контрагент_Key].name,
      d.СуммаДокумента,
    ]),
  ]);
  files["Реализация (акты, накладные, УПД).xlsx"] = writeXlsx([
    ["Дата", "Номер", "Контрагент", "Сумма"],
    ...c.ledger.Document_РеализацияТоваровУслуг.map((d) => [
      `${ru(d.Date)} 0:00:00`,
      updOf(d.ДокументОснование, "out")?.number ?? d.Number,
      cps[d.Контрагент_Key].name,
      d.СуммаДокумента,
    ]),
  ]);

  // an EDO registry: title lines, in and out apart, no basis
  const KIND = { invoice: "Счет на оплату", upd: "УПД (СЧФДОП)", act: "Акт", recon: "Акт сверки" };
  const STATUS = { signed: "Документооборот завершен", awaiting: "Ожидается подпись", rejected: "Отказано в подписи" };
  for (const [dir, label] of [
    ["in", "входящие"],
    ["out", "исходящие"],
  ])
    files[`Диадок ${label}.csv`] = csv1251([
      [`Реестр документов (${label})`],
      [`Организация: ${c.firm.name}, период ${ru(period.from)} — ${ru(period.to)}`],
      [],
      [
        "Тип документа",
        "Номер документа",
        "Дата документа",
        "Контрагент",
        "ИНН контрагента",
        "КПП контрагента",
        "Сумма",
        "Сумма НДС",
        "Статус документооборота",
      ],
      ...c.edo
        .filter((d) => d.dir === dir)
        .map((d) => [
          KIND[d.kind] ?? d.kind,
          d.number,
          ru(d.date),
          d.counterparty,
          d.inn,
          c.counterparties.find((x) => x.inn === d.inn)?.kpp ?? "",
          rub(d.amount),
          rub(d.vat),
          STATUS[d.status] ?? d.status,
        ]),
    ]);

  if (c.mail?.length) files["Почта бухгалтерии.mbox"] = writeMbox(c.mail);

  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  return Object.keys(files);
}

// ---- the same base through 1C's standard OData interface (connectors/odata1c.mjs)

const guid = (s) => {
  const h = createHash("sha1").update(String(s)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** The firm's ledger as 1C's OData answers it: GUID keys, the supplier's
 *  numbers in НомерВходящегоДокумента, the same numbers the lists above
 *  carry. Two things a real base has and the lists do not: an invoice marked
 *  for deletion and a receipt saved but not posted; neither may count. */
export function odataLedger(c) {
  const byOb = Object.fromEntries(c.obligations.map((o) => [o.number, o]));
  const updOf = (number, dir) => (c.upds ?? c.edo).find((d) => d.kind === "upd" && d.basis === number && d.dir === dir);
  const key = Object.fromEntries(c.counterparties.map((x) => [x.id, guid(`cp-${x.inn}`)]));
  const doc = (set, d, fields) => ({
    Ref_Key: guid(`${set}-${d.Ref_Key}`),
    DataVersion: "AAAAAQAAAAA=",
    DeletionMark: false,
    Date: d.Date,
    Контрагент_Key: key[d.Контрагент_Key],
    СуммаДокумента: d.СуммаДокумента,
    ...fields,
  });
  const L = c.ledger;
  const out = {
    Catalog_Контрагенты: c.counterparties.map((x) => ({
      Ref_Key: key[x.id],
      DeletionMark: false,
      Description: x.name,
      НаименованиеПолное: full(x.name),
      ИНН: x.inn,
      КПП: x.kpp,
    })),
    Document_СчетНаОплатуПоставщика: L.Document_СчетНаОплатуПоставщика.map((d, i) =>
      doc("ap", d, {
        Number: `0000-${String(i + 1).padStart(6, "0")}`,
        НомерВходящегоДокумента: byOb[d.Number]?.incoming ?? d.Number,
        ДатаВходящегоДокумента: d.Date,
        Posted: false,
      }),
    ),
    Document_СчетНаОплатуПокупателю: L.Document_СчетНаОплатуПокупателю.map((d) =>
      doc("ar", d, { Number: d.Number, СрокОплаты: d.СрокОплаты, Posted: false }),
    ),
    Document_ПоступлениеТоваровУслуг: L.Document_ПоступлениеТоваровУслуг.map((d, i) =>
      doc("in", d, {
        Number: `0000-${String(i + 1).padStart(6, "0")}`,
        НомерВходящегоДокумента: updOf(d.ДокументОснование, "in")?.number ?? "",
        ДатаВходящегоДокумента: d.Date,
        Posted: true,
      }),
    ),
    Document_РеализацияТоваровУслуг: L.Document_РеализацияТоваровУслуг.map((d) =>
      doc("out", d, { Number: updOf(d.ДокументОснование, "out")?.number ?? d.Number, Posted: true }),
    ),
  };
  const ar = out.Document_СчетНаОплатуПокупателю[0];
  if (ar) out.Document_СчетНаОплатуПокупателю.push({ ...ar, Ref_Key: guid("deleted"), Number: `${ar.Number}-копия`, DeletionMark: true });
  const rc = out.Document_ПоступлениеТоваровУслуг[0];
  if (rc)
    out.Document_ПоступлениеТоваровУслуг.push({
      ...rc,
      Ref_Key: guid("unposted"),
      Number: "0000-999999",
      НомерВходящегоДокумента: "черновик",
      Posted: false,
    });
  return out;
}

/** The letters as a Maildir an IMAP server reads (the VM's documents box). */
export async function writeMaildir(c, dir) {
  for (const sub of ["cur", "new", "tmp"]) await mkdir(join(dir, sub), { recursive: true });
  await Promise.all(
    (c.mail ?? []).map((l, i) => writeFile(join(dir, "cur", `${1700000000 + i}.stand${i + 1}.contour:2,`), writeEml(l, i + 1))),
  );
  return c.mail?.length ?? 0;
}

const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const out = opt("--out");
  const maildir = opt("--maildir");
  if (!out && !maildir) {
    console.log(`usage: exports.mjs [--seed 41] --out <dir> [--connected]   the synthetic firm as a bookkeeper's exports;
         --connected leaves out what the connectors bring (bank A, the 1C lists, the mail)
       exports.mjs [--seed 41] --maildir <dir>   its letters as a Maildir`);
    process.exit(2);
  }
  const { firm, quirks } = realistic(generate({ seed: Number(opt("--seed", 41)) }));
  if (maildir) console.log(`${await writeMaildir(firm, maildir)} писем в ${maildir}`);
  if (out) {
    let files = await writeExports(firm, out);
    if (args.includes("--connected")) {
      const covered = (f) =>
        f.includes(firm.accounts.a.account) || /^(Контрагенты|Счета|Поступление|Реализация)/.test(f) || f.endsWith(".mbox");
      for (const f of files.filter(covered)) await rm(join(out, f));
      files = files.filter((f) => !covered(f));
    }
    console.log(`${files.length} файлов в ${out}: ${files.join(", ")}`);
    for (const q of quirks) console.log(`  · ${q}`);
  }
}
