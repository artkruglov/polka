// The bookkeeper's verdict on an audit (fin.mjs review, fin.mjs score
// --review): a real company has no reference list of tails, so the one who
// keeps its books marks each tail the agent found and adds the ones it
// missed. That gives precision and recall on real data — assumption 2 of the
// product (the agent matches like a bookkeeper).
import { rowsOf } from "./imports/tables.mjs";

export const COLUMNS = ["обязательство", "сторона", "контрагент", "инн", "хвост", "сумма", "верно", "комментарий"];
const YES = /^(да|верно|\+|yes|y|1)$/i;
const NO = /^(нет|неверно|-|no|n|0)$/i;
const MISSED = /^(пропущен|пропущено|пропуск|missed)$/i;
const cell = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** The tails as a sheet to mark: «верно» is да or нет; a missed tail is a new line with «пропущено». */
export function reviewSheet(tails) {
  const rows = tails.map((t) => [t.number, t.side, t.name, t.inn, t.kind, t.sum.toFixed(2), "", ""]);
  return "﻿" + [COLUMNS, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

/** Counts of a marked sheet (.csv as saved by Excel, or .xlsx). */
export function scoreReview(file, bytes) {
  const rows = rowsOf(file, bytes).filter((r) => r.some((c) => String(c ?? "").trim()));
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const at = (name) => head.indexOf(name);
  if (at("верно") < 0) throw new Error("в файле нет колонки «верно»");
  const r = { confirmed: 0, wrong: 0, missed: 0, unmarked: 0, wrongRows: [], missedRows: [] };
  for (const row of rows.slice(1)) {
    const v = String(row[at("верно")] ?? "").trim();
    const what = `${row[at("обязательство")]} ${row[at("хвост")]}`.trim();
    if (YES.test(v)) r.confirmed++;
    else if (NO.test(v)) (r.wrong++, r.wrongRows.push(what));
    else if (MISSED.test(v)) (r.missed++, r.missedRows.push(what));
    else r.unmarked++;
  }
  const marked = r.confirmed + r.wrong;
  r.precision = marked ? r.confirmed / marked : null;
  r.recall = r.confirmed + r.missed ? r.confirmed / (r.confirmed + r.missed) : null;
  return r;
}
