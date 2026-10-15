// A CSV work drawn as a table (docs/specs/SINGLE_FILE_FORMATS.md). Pure and
// synchronous: a small file is drawn on the request, a larger one in the
// reader pool (html-pool-worker.ts) under a deadline.
import Papa from "papaparse";
import { escapeHtml } from "../../packages/contracts/html.ts";

/** Rows shown under the header; the rest stays in the file. */
export const CSV_MAX_ROWS = 2_000;
/** Columns shown; a wider file is cut with a note. */
export const CSV_MAX_COLUMNS = 200;

const plural = new Intl.PluralRules("ru");
const word = (count: number, one: string, few: string, many: string) =>
  ({ one, few, many })[plural.select(count) as "one" | "few" | "many"] ?? many;
const number = (count: number) => count.toLocaleString("ru-RU");

/** The body of the page: a note on what is shown and the table, every cell escaped. */
export function csvTableHtml(source: string): string {
  // The delimiter (comma, semicolon, tab) is detected; a spreadsheet's BOM is dropped.
  const parsed = Papa.parse<string[]>(source.replace(/^﻿/, ""), {
    preview: CSV_MAX_ROWS + 2,
    skipEmptyLines: "greedy",
  });
  const rows = parsed.data.filter((row) => Array.isArray(row));
  if (!rows.length) return `<p class="polka-note">Таблица пустая.</p>`;
  const [head, ...rest] = rows as [string[], ...string[][]];
  const body = rest.slice(0, CSV_MAX_ROWS);
  const more = rest.length > CSV_MAX_ROWS;
  const columns = Math.max(...rows.map((row) => row.length));
  const shownColumns = Math.min(columns, CSV_MAX_COLUMNS);
  const cells = (row: string[], tag: "td" | "th") => {
    let html = "";
    for (let index = 0; index < shownColumns; index++) html += `<${tag}>${escapeHtml(row[index] ?? "")}</${tag}>`;
    return html;
  };
  const notes = [
    more
      ? `Показаны первые ${number(CSV_MAX_ROWS)} строк. Вся таблица — в файле: скачайте оригинал.`
      : `${number(body.length)} ${word(body.length, "строка", "строки", "строк")} · ${number(columns)} ${word(columns, "столбец", "столбца", "столбцов")}`,
    columns > shownColumns ? `Показаны первые ${number(shownColumns)} столбцов из ${number(columns)}.` : "",
  ].filter(Boolean);
  let table = `<table class="polka-sheet"><thead><tr><th class="polka-row"></th>${cells(head, "th")}</tr></thead><tbody>`;
  body.forEach((row, index) => {
    table += `<tr><td class="polka-row">${index + 1}</td>${cells(row, "td")}</tr>`;
  });
  table += "</tbody></table>";
  return `${notes.map((note) => `<p class="polka-note">${escapeHtml(note)}</p>`).join("")}${table}`;
}
