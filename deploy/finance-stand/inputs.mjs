// What a reconciliation step gets in /work/in (catalog/skills/fin-match):
// operations of every bank in one shape, EDO documents, the ledger and the
// firm. The coordinator builds it — from the stand's systems, from a
// generated firm, or from a company's own exports — so the sandbox never
// needs a bank token.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clientBankExchange, cp1251, tapiOperation } from "./company/gen.mjs";
import { normalize } from "./adapters/tbank.mjs";
import { operations as clientBank } from "./adapters/clientbank.mjs";
import { states as obligationStates, tails as journalTails } from "./obligations.mjs";

const LEDGER = [
  "Catalog_Контрагенты",
  "Document_СчетНаОплатуПоставщика",
  "Document_СчетНаОплатуПокупателю",
  "Document_ПоступлениеТоваровУслуг",
  "Document_РеализацияТоваровУслуг",
];

/** A generated firm (company/gen.mjs generate) as a step's inputs. */
export function fromFirm(c) {
  return {
    operations: [
      ...c.bankA.map((o) => normalize(tapiOperation(o, c.firm, c.accounts.a), "a")),
      ...clientBank(cp1251(clientBankExchange(c.bankB, c.firm, c.accounts.b, c.firm.period)), "b"),
    ],
    edo: c.edo,
    ledger: Object.fromEntries(LEDGER.map((k) => [k, c.ledger[k]])),
    firm: { inn: c.firm.inn, name: c.firm.name, asOf: c.firm.period.asOf },
  };
}

/** The stand's systems as they are now; readBank holds the bank token. */
export async function fromSystems({ fin, readBank, company }) {
  const get = async (path) => (await fetch(`${fin}${path}`)).json();
  const ledger = {};
  for (const k of LEDGER) ledger[k] = (await get(`/ledger1c/odata/${encodeURIComponent(k)}`)).value;
  return {
    operations: [...(await readBank("a")), ...(await readBank("b"))],
    edo: await get("/edo/documents"),
    ledger,
    firm: { inn: company.firm.inn, name: company.firm.name, asOf: company.firm.period.asOf },
  };
}

// ---- a company's own exports (fin.mjs audit): the formats the audit takes
//   *.txt                1CClientBankExchange from any bank
//   *.json               a T-API statement ({operations: [...]}) or a list of its operations
//   edo.csv              номер;дата;инн;контрагент;вид;направление;сумма;ндс;основание;статус
//   invoices.csv         номер;дата;инн;контрагент;сторона;сумма;срок
//   receipts.csv         основание;сумма   (поступления и реализации из учёта, проведённые)
//   firm.json            {"inn": "...", "name": "...", "asOf": "YYYY-MM-DD"}
const csv = (text) => {
  const [head, ...rows] = text.replace(/^﻿/, "").trim().split(/\r?\n/);
  const keys = head.split(";").map((k) => k.trim());
  return rows.filter(Boolean).map((r) => Object.fromEntries(r.split(";").map((v, i) => [keys[i], v.trim()])));
};
const num = (v) => Number(String(v).replace(/\s/g, "").replace(",", "."));
const date = (v) => (/^\d{2}\.\d{2}\.\d{4}$/.test(v) ? v.split(".").reverse().join("-") : v.slice(0, 10));

export async function fromExports(dir) {
  const names = await readdir(dir);
  const firm = JSON.parse(await readFile(join(dir, "firm.json"), "utf8"));
  const operations = [];
  for (const n of names) {
    if (n.endsWith(".txt")) operations.push(...clientBank(await readFile(join(dir, n)), n.replace(/\.txt$/, "")));
    if (n.endsWith(".json") && n !== "firm.json") {
      const j = JSON.parse(await readFile(join(dir, n), "utf8"));
      operations.push(
        ...(Array.isArray(j) ? j : (j.operations ?? [])).map((o) => normalize(o, n.replace(/\.json$/, ""))),
      );
    }
  }
  const read = async (n) => (names.includes(n) ? csv(decodeText(await readFile(join(dir, n)))) : []);
  const invoices = await read("invoices.csv");
  const cps = new Map();
  for (const i of invoices) cps.set(i.инн, { Ref_Key: `cp-${i.инн}`, Description: i.контрагент, ИНН: i.инн });
  const doc = (i) => ({
    Number: i.номер,
    Date: date(i.дата),
    Контрагент_Key: `cp-${i.инн}`,
    СуммаДокумента: num(i.сумма),
    СрокОплаты: date(i.срок || i.дата),
    Posted: true,
  });
  const receipts = (await read("receipts.csv")).map((r) => ({
    ДокументОснование: r.основание,
    СуммаДокумента: num(r.сумма),
    Posted: true,
  }));
  return {
    operations,
    edo: (await read("edo.csv")).map((d, k) => ({
      id: `edo-${k + 1}`,
      kind: /упд|upd/i.test(d.вид) ? "upd" : /сч/i.test(d.вид) ? "invoice" : d.вид,
      dir: /вход|in/i.test(d.направление) ? "in" : "out",
      inn: d.инн,
      counterparty: d.контрагент,
      number: d.номер,
      date: date(d.дата),
      amount: num(d.сумма),
      vat: num(d.ндс),
      basis: d.основание,
      status: /отклон|reject/i.test(d.статус) ? "rejected" : /подпис|signed/i.test(d.статус) ? "signed" : "awaiting",
    })),
    ledger: {
      Catalog_Контрагенты: [...cps.values()],
      Document_СчетНаОплатуПоставщика: invoices.filter((i) => /ap|поставщ/i.test(i.сторона)).map(doc),
      Document_СчетНаОплатуПокупателю: invoices.filter((i) => /ar|покуп/i.test(i.сторона)).map(doc),
      Document_ПоступлениеТоваровУслуг: receipts,
      Document_РеализацияТоваровУслуг: [],
    },
    firm,
  };
}
// A CSV saved by Excel in Russia is often windows-1251.
const decodeText = (bytes) => {
  const utf = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return utf.includes("�") ? new TextDecoder("windows-1251").decode(bytes) : utf;
};

export async function writeInputs(dir, inputs) {
  await mkdir(dir, { recursive: true });
  for (const [name, value] of Object.entries(inputs)) await writeFile(join(dir, `${name}.json`), JSON.stringify(value));
  return Object.keys(inputs).map((n) => join(dir, `${n}.json`));
}

// ---- what the follow-up steps get: the journal's view, not the systems

const counterpartiesOf = (company) =>
  company.counterparties.map((c) => ({ inn: c.inn, name: c.name, email: c.email, edo: c.edo }));

/** Tails, the address book and today: what fin-chase and fin-remind see. */
export function fromJournal({ events, company, today }) {
  return {
    tails: journalTails(events, company.firm.period.asOf),
    counterparties: counterpartiesOf(company),
    firm: { name: company.firm.name, inn: company.firm.inn, today },
  };
}

/** New letters of the finance box, with the same view (fin-inbox). */
export function fromInbox({ letters, events, company, today }) {
  return { letters, ...fromJournal({ events, company, today }) };
}

/** Obligations per counterparty in EDO (fin-recon). */
export function fromStates({ events, company, today }) {
  const all = obligationStates(events);
  return {
    states: counterpartiesOf(company).map((c) => ({
      ...c,
      obligations: all
        .filter((s) => s.inn === c.inn)
        .map((s) => ({ number: s.number, side: s.side, amount: s.amount, paid: s.paid })),
    })),
    firm: {
      name: company.firm.name,
      inn: company.firm.inn,
      today,
      period: `${company.firm.period.from} — ${company.firm.period.to}`,
    },
  };
}
