// A company's tables as the audit takes them (fin.mjs audit): a 1C list saved
// to Excel or CSV, an EDO registry, the stand's own CSV layouts. The kind of a
// file comes from its name or, failing that, its header; columns are found by
// the names 1C, Диадок and СБИС give them. What was taken for what goes to the
// export passport, so the first real export shows at once what to add here.
import { readXlsx } from "./xlsx.mjs";

// field: header names, compared after normalizing (lower case, ё→е, no dots or extra spaces)
const FIELDS = {
  date: ["дата", "дата документа", "дата счета", "дата счёта"],
  number: ["номер", "номер документа", "номер счета", "№", "№ документа"],
  incoming: [
    "номер вх",
    "номер входящего",
    "номер входящего документа",
    "вх номер",
    "входящий номер",
    "номер вх документа",
    "номер счета поставщика",
  ],
  counterparty: ["контрагент", "покупатель", "поставщик", "наименование контрагента", "организация-контрагент"],
  name: ["наименование", "полное наименование", "краткое наименование", "контрагент", "наименование контрагента"],
  inn: ["инн", "инн контрагента", "инн покупателя", "инн поставщика"],
  kpp: ["кпп", "кпп контрагента"],
  email: ["email", "e-mail", "эл почта", "электронная почта", "адрес электронной почты"],
  amount: ["сумма", "сумма документа", "сумма с ндс", "сумма, руб", "итого", "сумма документа с ндс", "всего"],
  vat: ["ндс", "сумма ндс", "в т ч ндс", "в том числе ндс"],
  due: ["срок оплаты", "оплатить до", "оплата до", "срок"],
  kind: ["тип документа", "тип", "вид документа", "вид"],
  status: ["статус", "статус документа", "статус документооборота", "состояние", "документооборот"],
  dir: ["направление", "входящий/исходящий", "вх/исх"],
  basis: ["основание", "документ-основание", "документ основание", "счет на оплату", "счет", "счёт"],
  side: ["сторона"],
};

// kind: what a file must have, what it may have, and how its name reads
export const KINDS = {
  contractors: { need: ["name", "inn"], may: ["kpp", "email"], file: /контрагент|contractor|counterpart/i },
  invoices_ar: {
    need: ["number", "date", "amount"],
    may: ["counterparty", "inn", "due"],
    file: /сч[её]т[а-я]*\s+покупател|исходящ[а-я]*\s+сч|invoices?[-_ ]ar/i,
  },
  invoices_ap: {
    need: ["number", "date", "amount"],
    may: ["incoming", "counterparty", "inn", "due"],
    file: /сч[её]т[а-я]*\s+(?:от\s+)?поставщик|входящ[а-я]*\s+сч|invoices?[-_ ]ap/i,
  },
  invoices: { need: ["number", "date", "amount", "side"], may: ["counterparty", "inn", "due"], file: /^invoices/i },
  receipts: {
    need: ["amount"],
    may: ["number", "date", "incoming", "counterparty", "inn", "basis"],
    file: /поступлени|receipts/i,
  },
  sales: { need: ["amount"], may: ["number", "date", "counterparty", "inn", "basis"], file: /реализаци|sales/i },
  edo: {
    need: ["number", "date", "amount"],
    may: ["kind", "counterparty", "inn", "kpp", "vat", "status", "dir", "basis"],
    file: /эдо|edo|диадок|сбис|реестр|kontur|diadoc|sbis/i,
  },
};

export const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A counterparty's name without its legal form and quotes: «ООО "Альфа"» ≡ «Альфа ООО». */
const FORMS =
  /(^| )(общество с ограниченной ответственностью|публичное акционерное общество|закрытое акционерное общество|открытое акционерное общество|акционерное общество|индивидуальный предприниматель|ооо|пао|ао|зао|оао|нао|ип)(?= |$)/g;
export const nameKey = (s) =>
  norm(s)
    .replace(/[^a-zа-я0-9]+/g, " ") // JS \b and \w know no Cyrillic
    .replace(FORMS, " ")
    .replace(/ +/g, " ")
    .trim();

/** «1 234 567,89», «1234567.89 руб.», 1234.5 → 1234567.89 */
export function amount(v) {
  if (typeof v === "number") return v;
  const s = String(v ?? "")
    .replace(/[\s  ]/g, "")
    .replace(/[^\d,.-]/g, "")
    .replace(/[,.]+$/, ""); // «руб.»
  if (!s) return NaN;
  const last = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  return last < 0 ? Number(s) : Number(s.slice(0, last).replace(/[,.]/g, "") + "." + s.slice(last + 1));
}

/** «01.07.2026», «01.07.2026 0:00:00», «2026-07-01», «01.07.26», an Excel serial → «2026-07-01» */
export function date(v) {
  if (typeof v === "number" && v > 20000 && v < 80000)
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

// A CSV saved by Excel in Russia is often windows-1251; a BOM means UTF-8.
export function decodeText(bytes) {
  const utf = new TextDecoder("utf-8").decode(bytes);
  return utf.includes("�") ? new TextDecoder("windows-1251").decode(bytes) : utf.replace(/^﻿/, "");
}

function parseCsv(text) {
  const first = text.split(/\r?\n/).slice(0, 20).join("\n");
  const sep = [";", "\t", ","].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') ((cell += '"'), i++);
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) (row.push(cell), (cell = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      (row.push(cell), rows.push(row), (row = []), (cell = ""));
    } else cell += ch;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows.map((r) => r.map((c) => c.trim()));
}

/** Rows of a .xlsx, .csv or .tsv file. */
export function rowsOf(file, bytes) {
  if (/\.xlsx$/i.test(file)) return readXlsx(bytes);
  return parseCsv(decodeText(bytes));
}

function fieldOf(header) {
  const h = norm(header);
  for (const [field, names] of Object.entries(FIELDS)) if (names.includes(h)) return field;
  return null;
}

/** The header row (the first of the first 15 that names two known fields) and its columns. */
function header(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const columns = {};
    rows[i].forEach((h, c) => {
      const f = fieldOf(h);
      if (f && !(f in columns)) columns[f] = { index: c, header: String(h).trim() };
    });
    // «Контрагент» names both a list's counterparty and the counterparty list's name.
    if (columns.counterparty && !columns.name) columns.name = columns.counterparty;
    if (columns.name && !columns.counterparty) columns.counterparty = columns.name;
    if (new Set(Object.values(columns).map((c) => c.index)).size >= 2) return { at: i, columns };
  }
  return null;
}

const fits = (k, columns) => KINDS[k].need.every((f) => f in columns);

/**
 * A table file as records of known fields.
 * { kind, how: "имя файла"|"заголовки", rows: [{field: value}], columns: {field: header}, missing: [optional fields not found] }
 * or { kind: null, why } when it is not a table the audit knows.
 */
export function readTable(file, bytes) {
  const rows = rowsOf(file, bytes);
  const h = header(rows);
  if (!h) return { kind: null, why: "не нашёл строку заголовков" };
  const { columns } = h;
  const byName = Object.keys(KINDS).filter((k) => KINDS[k].file.test(file) && fits(k, columns));
  let kind = byName[0],
    how = "имя файла";
  if (!kind) {
    how = "заголовки";
    kind =
      "side" in columns && fits("invoices", columns)
        ? "invoices"
        : ("kind" in columns || "status" in columns) && fits("edo", columns)
          ? "edo"
          : "inn" in columns && "name" in columns && !("amount" in columns)
            ? "contractors"
            : "incoming" in columns && "due" in columns && fits("invoices_ap", columns)
              ? "invoices_ap"
              : "due" in columns && fits("invoices_ar", columns)
                ? "invoices_ar"
                : null;
  }
  if (!kind)
    return {
      kind: null,
      why: `не понял, что это: колонки ${Object.values(columns)
        .map((c) => c.header)
        .join(", ")}`,
    };
  const take = [...KINDS[kind].need, ...KINDS[kind].may].filter((f) => f in columns);
  const records = rows
    .slice(h.at + 1)
    .filter((r) => r.some((c) => c !== "" && c !== undefined))
    .map((r) => Object.fromEntries(take.map((f) => [f, r[columns[f].index] ?? ""])))
    // a total line at the bottom of a 1C report: an amount and no number or name
    .filter((r) => !(kind !== "contractors" && !r.number && !r.counterparty && !r.basis && !r.incoming));
  return {
    kind,
    how,
    rows: records,
    columns: Object.fromEntries(take.map((f) => [f, columns[f].header])),
    missing: KINDS[kind].may.filter((f) => !(f in columns)),
  };
}
