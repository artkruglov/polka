// The content filter's rules over the editorial catalogue («Лента»,
// content/editorial): Полка publishes these itself, so the operator answers
// for them as a publisher (docs/EDITORIAL_CHECKLIST.md). Reads files only; no
// database, no network, no model.
//   npm run editorial:content-scan
import { readFile, readdir, stat } from "node:fs/promises";
import { inspectHtml } from "../apps/server/html.ts";
import {
  CATEGORY_LABEL,
  findingsOf,
  describeFindings,
} from "../apps/server/content-filter/policy.ts";
import { mergeResults, scanText } from "../apps/server/content-filter/scanner.ts";

const root = new URL("../content/editorial/", import.meta.url);
const entries = (await readdir(root)).filter((name) => !name.endsWith(".json")).sort();
let flagged = 0;
for (const slug of entries) {
  const directory = new URL(`${slug}/`, root);
  if (!(await stat(directory)).isDirectory()) continue;
  const files = ["index.html", "static/index.html"];
  const results = [];
  const notes: string[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await readFile(new URL(file, directory), "utf8");
    } catch {
      continue;
    }
    const inspection = inspectHtml(source);
    results.push(inspection.filter);
    if (inspection.filter.domains?.length)
      notes.push(`${file}: ссылки на домены из списка: ${inspection.filter.domains.join(", ")}`);
  }
  try {
    results.push(scanText(await readFile(new URL("README.md", directory), "utf8")));
  } catch {
    // No README.
  }
  const findings = findingsOf(mergeResults(...results));
  // Code signals below the threshold are listed too: an editorial page should
  // have none, and the reviewer decides whether a mention is an example.
  const code = mergeResults(...results).hits.malicious_code;
  const line = findings.length
    ? `ОТМЕЧЕНО: ${describeFindings(findings)}`
    : "чисто";
  if (findings.length) flagged++;
  console.log(
    [
      `${slug}: ${line}`,
      ...(code && !findings.some((finding) => finding.category === "malicious_code")
        ? [`  признаки в коде ниже порога (${CATEGORY_LABEL.malicious_code}): ${code.terms.join("; ")}`]
        : []),
      ...notes.map((note) => `  ${note}`),
    ].join("\n"),
  );
}
console.log(
  `\n${entries.length} материалов, отмечено фильтром: ${flagged}. Ручная проверка — docs/EDITORIAL_CHECKLIST.md.`,
);

