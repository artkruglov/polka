// The synthetic firm as a bookkeeper hands it over for an audit (fin.mjs
// audit): 1C lists saved to Excel, an EDO registry in windows-1251 with title
// lines, «Клиент-банк» files in two encodings, no firm.json. A few things real
// data does are put in on purpose, none of them a tail, so the reference
// tails stay what they were:
//   - one client pays two invoices with one order («по счетам № …, …»);
//   - two suppliers number their invoices alike («№ 15»);
//   - one supplier is on the simplified system and sends UPDs without VAT;
//   - the ledger's lists carry names, not INNs; the counterparty list spells them out in full.
// Generated data only: real exports never go to git.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VAT, clientBankExchange, cp1251, cp866, generate } from "./gen.mjs";
import { writeXlsx } from "../imports/xlsx.mjs";

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
  const updOf = (number, dir) => c.edo.find((d) => d.kind === "upd" && d.basis === number && d.dir === dir);
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

  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  return Object.keys(files);
}

const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const out = opt("--out");
  if (!out) {
    console.log("usage: exports.mjs [--seed 41] --out <dir>   the synthetic firm as a bookkeeper's exports");
    process.exit(2);
  }
  const { firm, quirks } = realistic(generate({ seed: Number(opt("--seed", 41)) }));
  const files = await writeExports(firm, out);
  console.log(`${files.length} файлов в ${out}: ${files.join(", ")}`);
  for (const q of quirks) console.log(`  · ${q}`);
}
