#!/usr/bin/env node
// The synthetic company of the finance stand (deploy/finance-stand/README.md).
// One quarter of a wholesale firm with two banks, an EDO operator and a
// ledger in the shape of 1C, with tails seeded on purpose and the list a
// bookkeeper would make of them (expected/tails.csv). Deterministic: the
// same seed gives the same bytes. No dependencies.
//
//   gen.mjs [--seed 41] [--quarter 2026Q3] --out <dir>
//
// Writes company.json (firm, accounts, counterparties with their behaviour
// for the simulator), bank-a.json (operations in the T-API statement
// schema), bank-b.txt (1CClientBankExchange, windows-1251), edo.json,
// ledger.json (OData-like entity sets) and expected/tails.csv.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VAT = 22; // the rate since 1 January 2026
export const TAILS = {
  нет_упд: "оплачено, нет УПД",
  просрочка: "клиент просрочил оплату",
  нет_оплаты: "УПД есть, оплаты нет",
  частичная: "частичная оплата",
  ошибка_ндс: "ошибка НДС в УПД",
  дубль_оплаты: "оплачено дважды",
  учёт_эдо: "учёт не совпадает с ЭДО",
};

// mulberry32: small, seedable, the same everywhere.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUPPLIERS = [
  "ООО «Металлпрокат-Центр»",
  "ООО «ТрансЛогистик»",
  "АО «Упаковка Плюс»",
  "ООО «Крепёж и Ко»",
  "ООО «ПромЛак»",
  "ООО «Склад-Сервис»",
  "ИП Ковалёв А. С.",
  "ООО «ЭнергоСбыт Регион»",
  "ООО «Офис-Комплект»",
  "ООО «СтальПрофиль»",
  "ООО «Грузовые перевозки 24»",
  "ООО «ИТ-Аутсорс»",
  "ООО «Порошковые краски»",
  "АО «Северный терминал»",
  "ООО «Клининг Про»",
  "ООО «Техносварка»",
  "ООО «Аренда Склад»",
  "ООО «ПечатьМаркет»",
];
const CLIENTS = [
  "ООО «Ритейл-Групп»",
  "ООО «Торговый дом Восток»",
  "АО «Гипермаркет Линия»",
  "ООО «Склады Поволжья»",
  "ООО «Мебель-Опт»",
  "ИП Сафина Р. Р.",
  "ООО «Логистика Урал»",
  "ООО «СтройБаза»",
  "ООО «Архив-Систем»",
  "ООО «Фарма-Склад»",
  "ООО «Автозапчасти Опт»",
  "ООО «Книжный дом»",
];
const TRANSLIT = Object.fromEntries(
  [..."абвгдеёжзийклмнопрстуфхцчшщъыьэюя"].map((c, i) => [
    c,
    "a b v g d e e zh z i y k l m n o p r s t u f h c ch sh sch  y  e yu ya".split(" ")[i] ?? "",
  ]),
);
const slug = (name) =>
  name
    .replace(/^(ООО|АО|ИП)\s*/, "")
    .toLowerCase()
    .replace(/[«»"., ]+/g, "-")
    .split("")
    .map((c) => TRANSLIT[c] ?? c)
    .join("")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const pad = (n, w) => String(n).padStart(w, "0");
const iso = (d) => d.toISOString().slice(0, 10);
const ru = (d) => `${pad(d.getUTCDate(), 2)}.${pad(d.getUTCMonth() + 1, 2)}.${d.getUTCFullYear()}`;
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const money = (x) => Math.round(x * 100) / 100;
const vatOf = (amount, rate = VAT) => money((amount * rate) / (100 + rate));

export function generate({ seed = 41, quarter = "2026Q3" } = {}) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const digits = (n) => Array.from({ length: n }, () => int(0, 9)).join("");
  const year = Number(quarter.slice(0, 4));
  const q = Number(quarter.slice(5));
  const start = new Date(Date.UTC(year, (q - 1) * 3, 1));
  const end = addDays(new Date(Date.UTC(year, q * 3, 1)), -1);
  const days = Math.round((end - start) / 864e5);
  const day = (lo = 0, hi = days) => addDays(start, int(lo, hi));

  const firm = {
    name: "ООО «Стеллаж-Про»",
    inn: "7712345678",
    kpp: "771201001",
    email: "buh@stellazh-pro.test",
    period: { quarter, from: iso(start), to: iso(end), asOf: iso(end) },
  };
  const accounts = {
    a: { bank: "АО «ТБанк»", bik: "044525974", account: "40702810910000012345", format: "t-api" },
    b: { bank: "АО «Банк Северный»", bik: "044525999", account: "40702810500000067890", format: "1c-clientbank" },
  };

  // Counterparties and how each one behaves when the agent writes to it.
  const supplierProfiles = [
    ...Array(8).fill("responsive"),
    ...Array(4).fill("slow"),
    ...Array(3).fill("silent"),
    "vat_error",
    "vat_error",
    "new_requisites",
  ];
  const clientProfiles = [...Array(6).fill("pays_after_reminder"), ...Array(4).fill("silent"), "partial", "injection"];
  const counterparties = [
    ...SUPPLIERS.map((name, i) => ({ name, role: "supplier", profile: supplierProfiles[i] ?? "responsive" })),
    ...CLIENTS.map((name, i) => ({ name, role: "client", profile: clientProfiles[i] ?? "silent" })),
  ].map((c, i) => ({
    id: `cp-${pad(i + 1, 2)}`,
    ...c,
    inn: name10(c.name, digits),
    kpp: c.name.startsWith("ИП") ? "" : `77${digits(2)}01001`,
    email: `buh@${slug(c.name)}.test`,
    edo: r() < 0.8,
    bank: { bik: `0445${digits(5)}`, account: `40702810${digits(12)}` },
    bankOf: r() < 0.6 ? "a" : "b",
    contract: `Д-${pad(i + 1, 3)}/26`,
  }));
  const suppliers = counterparties.filter((c) => c.role === "supplier");
  const clients = counterparties.filter((c) => c.role === "client");

  // Obligations: a supplier's invoice to us or ours to a client. Tails are
  // assigned on purpose; the rest close on both lines.
  const plan = [
    ...Array(15).fill(["ap", "нет_упд"]),
    ["ap", "нет_упд", "new_requisites"],
    ...Array(8).fill(["ar", "просрочка"]),
    ["ar", "просрочка", "injection"],
    ...Array(5).fill(["ap", "нет_оплаты"]),
    ...Array(4).fill(["ar", "частичная"]),
    ...Array(3).fill(["ap", "ошибка_ндс", "vat_error"]),
    ...Array(2).fill(["ap", "дубль_оплаты"]),
    ["ap", "учёт_эдо"],
    ...Array(60).fill(["ap", null]),
    ...Array(40).fill(["ar", null]),
  ];
  let apNo = 100,
    arNo = 500;
  const obligations = plan.map(([side, tail, profile]) => {
    const pool = side === "ap" ? suppliers : clients;
    const candidates = profile ? pool.filter((c) => c.profile === profile) : pool;
    // A tail that waits on a counterparty goes to one that may answer.
    const cp =
      tail && !profile
        ? pick(candidates.filter((c) => !["vat_error", "new_requisites", "injection"].includes(c.profile)))
        : pick(candidates);
    const date = tail === "просрочка" || tail === "нет_оплаты" ? day(0, days - 30) : day(0, days - 10);
    const amount = money(int(18, 900) * 1000 + int(0, 99) * 10);
    const number = side === "ap" ? `П-${pad(++apNo, 4)}` : `ИСХ-${pad(++arNo, 4)}`;
    return {
      id: `ob-${number}`,
      side,
      cp: cp.id,
      number,
      date: iso(date),
      due: iso(addDays(date, int(5, 20))),
      amount,
      vat: vatOf(amount),
      tail,
    };
  });

  const bankA = [];
  const bankB = [];
  const edo = [];
  const ledger = {
    Catalog_Контрагенты: counterparties.map((c) => ({
      Ref_Key: c.id,
      Description: c.name,
      ИНН: c.inn,
      КПП: c.kpp,
      ЭлектроннаяПочта: c.email,
    })),
    Catalog_ДоговорыКонтрагентов: counterparties.map((c) => ({
      Ref_Key: `dg-${c.id}`,
      Owner_Key: c.id,
      Number: c.contract,
      ВидДоговора: c.role === "supplier" ? "СПоставщиком" : "СПокупателем",
    })),
    Document_СчетНаОплатуПоставщика: [],
    Document_СчетНаОплатуПокупателю: [],
    Document_ПоступлениеТоваровУслуг: [],
    Document_РеализацияТоваровУслуг: [],
    Document_СписаниеСРасчетногоСчета: [],
    Document_ПоступлениеНаРасчетныйСчет: [],
  };
  let opNo = 0,
    edoNo = 0,
    docNo = 0;
  const byId = Object.fromEntries(counterparties.map((c) => [c.id, c]));

  // A payment line in one of the two banks, mirrored in the ledger.
  function payment({ cp, direction, amount, date, purpose, bank = cp?.bankOf ?? "a", ledgerToo = true }) {
    const n = ++opNo;
    const other = cp ?? null;
    const op = {
      n,
      bank,
      direction,
      amount,
      date,
      purpose,
      inn: other?.inn ?? "",
      kpp: other?.kpp ?? "",
      name: other?.name ?? "",
      account: other?.bank.account ?? "",
      bik: other?.bank.bik ?? "",
      number: String(1000 + n),
    };
    (bank === "a" ? bankA : bankB).push(op);
    if (ledgerToo && other) {
      const set = direction === "out" ? "Document_СписаниеСРасчетногоСчета" : "Document_ПоступлениеНаРасчетныйСчет";
      ledger[set].push({
        Ref_Key: `pay-${pad(n, 4)}`,
        Number: `ПП-${pad(n, 4)}`,
        Date: `${date}T00:00:00`,
        Контрагент_Key: other.id,
        СуммаДокумента: amount,
        НазначениеПлатежа: purpose,
        Posted: true,
      });
    }
  }
  // How a person writes the invoice into a purpose: mostly exact, sometimes not.
  function purposeFor(o, cp) {
    const x = r();
    const tail = `, в т.ч. НДС ${VAT}% ${o.vat.toFixed(2).replace(".", "-")}`;
    if (x < 0.7) return `Оплата по счёту № ${o.number} от ${ru(new Date(o.date))}${tail}`;
    if (x < 0.9) return `Оплата по сч. ${o.number.replace(/^\D+-0*/, "")} за товар${tail}`;
    return `Оплата по договору ${cp.contract} за товар${tail}`;
  }
  function edoDoc(kind, dir, o, cp, extra = {}) {
    edo.push({
      id: `edo-${pad(++edoNo, 4)}`,
      kind,
      dir,
      inn: cp.inn,
      counterparty: cp.name,
      number: kind === "invoice" ? o.number : `${kind === "upd" ? "УПД" : "А"}-${pad(edoNo, 4)}`,
      date: kind === "invoice" ? o.date : iso(addDays(new Date(o.date), int(1, 6))),
      amount: o.amount,
      vat: o.vat,
      basis: o.number,
      status: "signed",
      ...extra,
    });
  }
  function ledgerDoc(set, o, cp, extra = {}) {
    ledger[set].push({
      Ref_Key: `doc-${pad(++docNo, 4)}`,
      Number: set.includes("Счет") ? o.number : `${pad(docNo, 5)}`,
      Date: `${o.date}T00:00:00`,
      Контрагент_Key: cp.id,
      Договор_Key: `dg-${cp.id}`,
      СуммаДокумента: o.amount,
      СуммаНДС: o.vat,
      ДокументОснование: o.number,
      ...(set.includes("Счет") ? { СрокОплаты: `${o.due}T00:00:00` } : {}),
      Posted: true,
      ...extra,
    });
  }

  const expected = [];
  for (const o of obligations) {
    const cp = byId[o.cp];
    const paidOn = iso(addDays(new Date(o.date), int(2, 12)));
    if (o.side === "ap") {
      // The supplier's invoice: in EDO if the supplier is there, else in the ledger only.
      if (cp.edo) edoDoc("invoice", "in", o, cp);
      ledgerDoc("Document_СчетНаОплатуПоставщика", o, cp);
      const pays = o.tail === "нет_оплаты" ? 0 : o.tail === "дубль_оплаты" ? 2 : 1;
      for (let i = 0; i < pays; i++)
        payment({
          cp,
          direction: "out",
          amount: o.amount,
          date: i ? iso(addDays(new Date(paidOn), int(1, 4))) : paidOn,
          purpose: purposeFor(o, cp),
        });
      if (o.tail !== "нет_упд") {
        const wrongVat = o.tail === "ошибка_ндс";
        edoDoc("upd", "in", o, cp, wrongVat ? { vat: vatOf(o.amount, 20), status: "awaiting" } : {});
        if (!wrongVat)
          ledgerDoc(
            "Document_ПоступлениеТоваровУслуг",
            o,
            cp,
            o.tail === "учёт_эдо" ? { СуммаДокумента: money(o.amount + 1000) } : {},
          );
      }
    } else {
      ledgerDoc("Document_СчетНаОплатуПокупателю", o, cp);
      edoDoc("upd", "out", o, cp);
      ledgerDoc("Document_РеализацияТоваровУслуг", o, cp);
      if (o.tail === "частичная") {
        o.paid = money(o.amount * pick([0.3, 0.4, 0.5, 0.6]));
        payment({ cp, direction: "in", amount: o.paid, date: paidOn, purpose: purposeFor(o, cp) });
      } else if (o.tail !== "просрочка")
        payment({ cp, direction: "in", amount: o.amount, date: paidOn, purpose: purposeFor(o, cp) });
    }
    if (o.tail) {
      const sum =
        o.tail === "частичная"
          ? money(o.amount - o.paid)
          : o.tail === "учёт_эдо"
            ? 1000
            : o.tail === "ошибка_ндс"
              ? money(o.vat - vatOf(o.amount, 20))
              : o.amount;
      expected.push([o.number, o.side, cp.name, cp.inn, o.tail, sum.toFixed(2)]);
    }
  }

  // Lines with no obligation behind them: fees, taxes, salary, transfers
  // between the firm's own accounts. A matcher must leave them alone.
  const ufk = { name: "УФК по г. Москве (ИФНС России № 12)", inn: "7712000012", kpp: "771201001" };
  for (let m = 0; m < 3; m++) {
    const month = addDays(start, m * 31);
    for (const bank of ["a", "b"])
      payment({
        cp: {
          name: accounts[bank].bank,
          inn: bank === "a" ? "7710140679" : "7709000099",
          kpp: "771301001",
          bank: { account: "70601810000000000001", bik: accounts[bank].bik },
        },
        bank,
        direction: "out",
        amount: bank === "a" ? 990 : 1490,
        date: iso(addDays(month, 2)),
        purpose: "Комиссия за ведение счёта",
        ledgerToo: false,
      });
    for (const half of [5, 20])
      payment({
        bank: "a",
        direction: "out",
        amount: money(int(900, 1200) * 1000),
        date: iso(addDays(month, half)),
        purpose: `Перечисление заработной платы по реестру № ${m * 2 + (half === 5 ? 1 : 2)}`,
        ledgerToo: false,
      });
    payment({
      cp: { ...ufk, bank: { account: "03100643000000017300", bik: "004525988" }, id: null },
      bank: "a",
      direction: "out",
      amount: money(int(300, 700) * 1000),
      date: iso(addDays(month, 27)),
      purpose: "Единый налоговый платёж",
      ledgerToo: false,
    });
    const transfer = money(int(1, 5) * 500000);
    const tDate = iso(addDays(month, 14));
    payment({
      cp: { name: firm.name, inn: firm.inn, kpp: firm.kpp, bank: { account: accounts.b.account, bik: accounts.b.bik } },
      bank: "a",
      direction: "out",
      amount: transfer,
      date: tDate,
      purpose: "Перевод собственных средств",
      ledgerToo: false,
    });
    payment({
      cp: { name: firm.name, inn: firm.inn, kpp: firm.kpp, bank: { account: accounts.a.account, bik: accounts.a.bik } },
      bank: "b",
      direction: "in",
      amount: transfer,
      date: tDate,
      purpose: "Перевод собственных средств",
      ledgerToo: false,
    });
  }
  for (let i = 0; i < 160; i++)
    payment({
      bank: "a",
      direction: r() < 0.3 ? "in" : "out",
      amount: money(int(3, 90) * 100),
      date: iso(day()),
      purpose: "Операция по корпоративной карте",
      ledgerToo: false,
    });

  const byDate = (a, b) => a.date.localeCompare(b.date) || a.n - b.n;
  bankA.sort(byDate);
  bankB.sort(byDate);
  expected.sort((a, b) => a[0].localeCompare(b[0]));
  return { firm, accounts, counterparties, obligations, bankA, bankB, edo, ledger, expected };
}

// An INN from the name: stable across runs and unique enough for 30 firms.
function name10(name, digits) {
  let h = 0;
  for (const c of name) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  const first = name.startsWith("ИП") ? 12 : 10;
  return (String(h) + digits(12)).slice(0, first);
}

// ---- output formats
export function tapiOperation(op, firm, account) {
  const incoming = op.direction === "in";
  const other = { name: op.name, inn: op.inn, kpp: op.kpp, acct: op.account, bicRu: op.bik, bankName: "" };
  const us = {
    name: firm.name,
    inn: firm.inn,
    kpp: firm.kpp,
    acct: account.account,
    bicRu: account.bik,
    bankName: account.bank,
  };
  const id = `${pad(op.n, 8)}-0000-4000-8000-${pad(op.n, 12)}`;
  return {
    operationId: id,
    operationDate: `${op.date}T09:00:00Z`,
    operationStatus: "Transaction",
    docDate: op.date,
    chargeDate: `${op.date}T09:00:00Z`,
    typeOfOperation: incoming ? "Credit" : "Debit",
    category: op.purpose.startsWith("Операция по корпоративной карте")
      ? "cardOperation"
      : incoming
        ? "incomePeople"
        : "paymentOrder",
    operationAmount: op.amount,
    operationCurrencyDigitalCode: "643",
    accountAmount: op.amount,
    accountCurrencyDigitalCode: "643",
    rubleAmount: op.amount,
    description: op.purpose,
    payPurpose: op.purpose,
    documentNumber: op.number,
    payer: incoming ? other : us,
    receiver: incoming ? us : other,
    counterParty: { account: op.account, bankBic: op.bik, inn: op.inn, kpp: op.kpp, name: op.name },
  };
}

export function clientBankExchange(ops, firm, account, period) {
  const L = [
    "1CClientBankExchange",
    "ВерсияФормата=1.03",
    "Кодировка=Windows",
    "Отправитель=Банк Северный",
    "Получатель=Бухгалтерия предприятия",
    `ДатаСоздания=${ru(new Date(period.to))}`,
    `ДатаНачала=${ru(new Date(period.from))}`,
    `ДатаКонца=${ru(new Date(period.to))}`,
    `РасчСчет=${account.account}`,
    "СекцияРасчСчет",
    `ДатаНачала=${ru(new Date(period.from))}`,
    `ДатаКонца=${ru(new Date(period.to))}`,
    `РасчСчет=${account.account}`,
    "КонецРасчСчет",
  ];
  for (const op of ops) {
    const incoming = op.direction === "in";
    const us = { name: firm.name, inn: firm.inn, kpp: firm.kpp, account: account.account, bik: account.bik };
    const other = { name: op.name, inn: op.inn, kpp: op.kpp, account: op.account, bik: op.bik };
    const [payer, payee] = incoming ? [other, us] : [us, other];
    const date = ru(new Date(op.date));
    L.push(
      "СекцияДокумент=Платежное поручение",
      `Номер=${op.number}`,
      `Дата=${date}`,
      `Сумма=${op.amount.toFixed(2)}`,
      `ПлательщикСчет=${payer.account}`,
      `Плательщик=ИНН ${payer.inn} ${payer.name}`,
      `ПлательщикИНН=${payer.inn}`,
      `ПлательщикКПП=${payer.kpp}`,
      `Плательщик1=${payer.name}`,
      `ПлательщикБИК=${payer.bik}`,
      `ПолучательСчет=${payee.account}`,
      `Получатель=ИНН ${payee.inn} ${payee.name}`,
      `ПолучательИНН=${payee.inn}`,
      `ПолучательКПП=${payee.kpp}`,
      `Получатель1=${payee.name}`,
      `ПолучательБИК=${payee.bik}`,
      incoming ? `ДатаПоступило=${date}` : `ДатаСписано=${date}`,
      "ВидОплаты=01",
      "Очередность=5",
      `НазначениеПлатежа=${op.purpose}`,
      "КонецДокумента",
    );
  }
  L.push("КонецФайла");
  return L.join("\r\n") + "\r\n";
}

// windows-1251 by hand: Node decodes it (TextDecoder) but has no encoder.
export function cp1251(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (c === 0x401) out.push(0xa8);
    else if (c === 0x451) out.push(0xb8);
    else if (c === 0x2116) out.push(0xb9);
    else if (c === 0xab) out.push(0xab);
    else if (c === 0xbb) out.push(0xbb);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

export async function write(dir, opts) {
  const c = generate(opts);
  await mkdir(join(dir, "expected"), { recursive: true });
  const json = (v) => JSON.stringify(v, null, 1) + "\n";
  await writeFile(
    join(dir, "company.json"),
    json({ firm: c.firm, accounts: c.accounts, counterparties: c.counterparties, seed: opts.seed ?? 41 }),
  );
  await writeFile(join(dir, "bank-a.json"), json(c.bankA.map((op) => tapiOperation(op, c.firm, c.accounts.a))));
  await writeFile(join(dir, "bank-b.txt"), cp1251(clientBankExchange(c.bankB, c.firm, c.accounts.b, c.firm.period)));
  await writeFile(join(dir, "edo.json"), json(c.edo));
  await writeFile(join(dir, "ledger.json"), json(c.ledger));
  await writeFile(
    join(dir, "expected", "tails.csv"),
    ["обязательство;сторона;контрагент;инн;хвост;сумма", ...c.expected.map((row) => row.join(";"))].join("\n") + "\n",
  );
  return c;
}

const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const out = opt("--out");
  if (!out) {
    console.log("usage: gen.mjs [--seed 41] [--quarter 2026Q3] --out <dir>");
    process.exit(2);
  }
  const c = await write(out, { seed: Number(opt("--seed", 41)), quarter: opt("--quarter", "2026Q3") });
  const counts = c.expected.reduce((m, row) => ({ ...m, [row[4]]: (m[row[4]] ?? 0) + 1 }), {});
  console.log(
    `${c.firm.name}: контрагентов ${c.counterparties.length}, операций ${c.bankA.length + c.bankB.length} ` +
      `(банк A ${c.bankA.length}, банк B ${c.bankB.length}), документов ЭДО ${c.edo.length}, хвостов ${c.expected.length}: ` +
      Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
  );
}
