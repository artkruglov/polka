// 1C through its standard OData interface (…/odata/standard.odata), read
// only: a user of the base with the right to view, Basic over HTTPS. The
// connector takes what the audit takes from 1C's lists — counterparties,
// invoices both ways, receipts and sales of the period — and leaves out
// what is marked for deletion and receipts and sales that were not posted.
//
// The entity and field names are those of «Бухгалтерия предприятия» 3.0;
// they are checked against a real base at the first pilot. When a base
// lacks a field of $select, 1C answers 400: the connector asks once more
// without $select and takes the fields it knows.
import { get } from "./net.mjs";

export const ENTITIES = {
  Catalog_Контрагенты: ["Ref_Key", "DeletionMark", "Description", "НаименованиеПолное", "ИНН", "КПП"],
  Document_СчетНаОплатуПоставщика: [
    "Ref_Key",
    "DeletionMark",
    "Number",
    "Date",
    "НомерВходящегоДокумента",
    "ДатаВходящегоДокумента",
    "Контрагент_Key",
    "СуммаДокумента",
  ],
  Document_СчетНаОплатуПокупателю: [
    "Ref_Key",
    "DeletionMark",
    "Number",
    "Date",
    "Контрагент_Key",
    "СуммаДокумента",
    "СрокОплаты",
  ],
  Document_ПоступлениеТоваровУслуг: [
    "Ref_Key",
    "DeletionMark",
    "Posted",
    "Number",
    "Date",
    "НомерВходящегоДокумента",
    "Контрагент_Key",
    "СуммаДокумента",
  ],
  Document_РеализацияТоваровУслуг: [
    "Ref_Key",
    "DeletionMark",
    "Posted",
    "Number",
    "Date",
    "Контрагент_Key",
    "СуммаДокумента",
  ],
};
const POSTED = new Set(["Document_ПоступлениеТоваровУслуг", "Document_РеализацияТоваровУслуг"]);
const EMPTY_DATE = /^0001-01-01/;

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function list(base, entity, { auth, ca, from, to, top }) {
  const conditions = ["DeletionMark eq false"];
  if (entity.startsWith("Document_")) {
    conditions.push(`Date ge datetime${quote(`${from}T00:00:00`)}`);
    if (to) conditions.push(`Date lt datetime${quote(`${to}T00:00:00`)}`);
    if (POSTED.has(entity)) conditions.push("Posted eq true");
  }
  const rows = [];
  let select = true;
  for (let skip = 0; ; skip += top) {
    const q = new URLSearchParams({
      $format: "json",
      $filter: conditions.join(" and "),
      $orderby: "Ref_Key",
      $top: String(top),
      $skip: String(skip),
    });
    if (select) q.set("$select", ENTITIES[entity].join(","));
    const r = await get(`${base}/${encodeURIComponent(entity)}?${q}`, {
      headers: { authorization: auth, accept: "application/json" },
      ca,
    });
    if (r.status === 400 && select) {
      select = false;
      skip -= top;
      continue;
    }
    if (r.status === 401 || r.status === 403)
      throw new Error(`1С: доступ не дан (${r.status}) — проверьте пользователя и его права на чтение`);
    if (r.status !== 200) throw new Error(`1С: ${entity} → ${r.status} ${r.text.slice(0, 160)}`);
    const page = JSON.parse(r.text).value ?? [];
    rows.push(...page);
    if (page.length < top) break;
  }
  // The base filtered already; this holds even when a published base ignores $filter.
  return rows.filter(
    (d) =>
      d.DeletionMark !== true &&
      (!POSTED.has(entity) || d.Posted === true) &&
      (!entity.startsWith("Document_") || (String(d.Date) >= from && (!to || String(d.Date) < to))),
  );
}

/** The entities of the period: {entity: rows}. */
export async function readLedger({ base, user, password, ca, from, to, top = 500 }) {
  const auth = `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
  const out = {};
  for (const entity of Object.keys(ENTITIES))
    out[entity] = await list(base.replace(/\/$/, ""), entity, { auth, ca, from, to, top });
  return out;
}

/** The rows the audit's tables would hold for the same base (imports/audit.mjs). */
export function tablesOf(entities) {
  const cps = new Map((entities.Catalog_Контрагенты ?? []).map((c) => [c.Ref_Key, c]));
  const party = (d) => {
    const c = cps.get(d.Контрагент_Key);
    return { counterparty: c?.Description ?? "", inn: c?.ИНН ?? "" };
  };
  const day = (v) => (v && !EMPTY_DATE.test(v) ? String(v).slice(0, 10) : "");
  const inc = (d) => (d.НомерВходящегоДокумента ? { incoming: String(d.НомерВходящегоДокумента) } : {});
  const row = (d) => ({
    number: String(d.Number ?? "").trim(),
    date: day(d.Date),
    amount: Number(d.СуммаДокумента),
    ...party(d),
  });
  return {
    contractors: [...cps.values()].map((c) => ({ name: c.Description, inn: c.ИНН, kpp: c.КПП ?? "" })),
    invoices: [
      ...(entities.Document_СчетНаОплатуПоставщика ?? []).map((d) => ({ ...row(d), ...inc(d), side: "ap" })),
      ...(entities.Document_СчетНаОплатуПокупателю ?? []).map((d) => ({
        ...row(d),
        side: "ar",
        ...(day(d.СрокОплаты) ? { due: day(d.СрокОплаты) } : {}),
      })),
    ],
    receipts: (entities.Document_ПоступлениеТоваровУслуг ?? []).map((d) => ({ ...row(d), ...inc(d) })),
    sales: (entities.Document_РеализацияТоваровУслуг ?? []).map(row),
  };
}
