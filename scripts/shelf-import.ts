// Operator: save a shelf exported from another installation (polka-export.mjs)
// onto a personal shelf here (docs/specs/SHELF_TRANSFER.md,
// apps/server/shelf-import.ts). Runs as the runtime database role; prints no
// content, only titles and counts.
//
//   npm run shelf:import -- --dir <export folder> --account <login|email|id> [--dry-run] [--raise-quota] [--replace-card] [--json]
//
// Start with --dry-run: it checks every file and prints what would be saved.
// Rerunning after an interruption continues where the last run stopped.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { flushAnalytics } from "../apps/server/analytics.ts";
import { db } from "../apps/server/db.ts";
import { ImportRefusal, importShelf, type ImportReport } from "../apps/server/shelf-import.ts";
import { s3 } from "../apps/server/storage.ts";

const USAGE =
  "Usage: shelf-import.ts --dir <папка выгрузки> --account <login|email|id> [--dry-run] [--raise-quota] [--replace-card] [--json]";

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} МБ`;

export function formatImportReport(report: ImportReport) {
  const lines = [
    `${report.dryRun ? "Проверка (ничего не сохранено)" : "Перенос"}: ${report.source.origin} → ${report.account}`,
    `Работ: ${report.works}, версий: ${report.versions}; ещё сохранить: ${mb(report.bytesNeeded)}`,
    `Место: занято ${mb(report.quota.used)} из ${mb(report.quota.total)}${report.quota.raisedTo ? `, лимит поднят до ${mb(report.quota.raisedTo)}` : ""}`,
  ];
  if (report.dryRun && report.quota.used + report.bytesNeeded > report.quota.total)
    lines.push("Места не хватит: запустите с --raise-quota.");
  if (report.foldersCreated.length) lines.push(`Папки: ${report.foldersCreated.join(", ")}`);
  if (report.card === "kept") lines.push("Карточка полки не заменена: на этой полке своя (--replace-card).");
  if (report.card === "set") lines.push("Карточка полки перенесена.");
  for (const work of report.imported)
    lines.push(
      `  + «${work.title}»: сохранено версий ${work.saved}${work.already ? `, уже было ${work.already}` : ""}${
        work.blocked.length
          ? `; заблокировано модерацией этой установки: ${work.blocked.map((n) => `v${n}`).join(", ")}`
          : ""
      }`,
    );
  const blocked = report.imported.filter((work) => work.blocked.length);
  if (blocked.length)
    lines.push(
      `Модерация этой установки изолировала версии в ${blocked.length} работах: они сохранены, но не открываются. Решение — в разделе модерации (moderation.ts).`,
    );
  for (const work of report.skipped) lines.push(`  − «${work.title}»: ${work.reason}`);
  if (report.incomplete) lines.push("Перенос остановлен на полпути: запустите команду ещё раз.");
  return lines.join("\n");
}

export async function runShelfImport(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      account: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "raise-quota": { type: "boolean", default: false },
      "replace-card": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.dir || !values.account) {
    console.error(USAGE);
    return 2;
  }
  try {
    const report = await importShelf({
      dir: values.dir,
      account: values.account,
      dryRun: values["dry-run"],
      raiseQuota: values["raise-quota"],
      replaceCard: values["replace-card"],
      progress: values.json ? undefined : (line) => console.error(JSON.stringify(line)),
    });
    console.log(values.json ? JSON.stringify(report, null, 2) : formatImportReport(report));
    await flushAnalytics();
    return report.skipped.length || report.incomplete ? 1 : 0;
  } catch (error) {
    if (error instanceof ImportRefusal) {
      console.error(`Отказ: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runShelfImport(process.argv.slice(2));
  } finally {
    await db.end();
    s3.destroy();
  }
}
