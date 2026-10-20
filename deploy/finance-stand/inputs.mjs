// What a reconciliation step gets in /work/in (catalog/skills/fin-match):
// operations of every bank in one shape, EDO documents, the ledger and the
// firm. The coordinator builds it — from the stand's systems, from a
// generated firm, or from a company's own exports — so the sandbox never
// needs a bank token.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clientBankExchange, cp1251, tapiOperation } from "./company/gen.mjs";
import { normalize } from "./adapters/tbank.mjs";
import { operations as clientBank } from "./adapters/clientbank.mjs";
import { readExports } from "./imports/audit.mjs";
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

// ---- a company's own exports (fin.mjs audit): imports/audit.mjs reads them
// and says in the export passport what it took each file for.
export async function fromExports(dir, opts) {
  return (await readExports(dir, opts)).inputs;
}

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
