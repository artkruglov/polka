// Product metrics for the operator (apps/server/metrics.ts, analytics.ts).
// Runs as the runtime database role; prints counts only, never identifiers.
//   npm run metrics                      the report for the last 12 weeks
//   npm run metrics -- --weeks 26        a longer window (1–56)
//   npm run metrics -- --json            the same JSON as GET /api/ops/metrics
//   npm run metrics -- forget <account>  an objection (privacy policy): delete
//        the account's usage events and stop recording new ones. <account> is
//        the account id, login or email.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { forgetAccount } from "../apps/server/analytics.ts";
import { db } from "../apps/server/db.ts";
import { metricsReport, type MetricsReport } from "../apps/server/metrics.ts";

const USAGE =
  "Usage: npm run metrics [-- --weeks N] [-- --json] | npm run metrics -- forget <account id|login|email>";

const percent = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;

function table(headers: string[], rows: Array<Array<string | number>>) {
  const cells = [headers, ...rows.map((row) => row.map(String))];
  const widths = headers.map((_, column) =>
    Math.max(...cells.map((row) => [...(row[column] ?? "")].length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, column) =>
        column === 0
          ? cell.padEnd(widths[column]!)
          : cell.padStart(widths[column]!),
      )
      .join("  ");
  return [
    line(cells[0]!),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...cells.slice(1).map(line),
  ].join("\n");
}

/** The report as plain text tables (the page at /ops/metrics shows the same). */
export function formatReport(report: MetricsReport) {
  const { funnel } = report;
  const out = [
    `Метрики Полки: ${report.weeks} нед. с ${report.since} (UTC), на ${report.today}`,
    "",
    "Воронка по неделям регистрации (каждый шаг — из прошедших предыдущий)",
    table(
      [
        "Неделя",
        "Посещ.",
        "Рег.",
        "Агент",
        "Сохр.",
        "Ссылка",
        "Откр.",
        "Пос→рег",
        "Рег→агент",
        "Агент→сохр",
        "Сохр→ссылка",
        "Ссылка→откр",
      ],
      [
        ...funnel.weeks.map((week) => [
          week.week,
          week.visitors,
          week.signups,
          week.agentConnected,
          week.firstSave,
          week.firstShare,
          week.shareOpened,
          percent(week.conversion.visitorToSignup),
          percent(week.conversion.signupToAgent),
          percent(week.conversion.agentToSave),
          percent(week.conversion.saveToShare),
          percent(week.conversion.shareToOpened),
        ]),
        [
          "Всего",
          funnel.total.visitors,
          funnel.total.signups,
          funnel.total.agentConnected,
          funnel.total.firstSave,
          funnel.total.firstShare,
          funnel.total.shareOpened,
          percent(funnel.total.conversion.visitorToSignup),
          percent(funnel.total.conversion.signupToAgent),
          percent(funnel.total.conversion.agentToSave),
          percent(funnel.total.conversion.saveToShare),
          percent(funnel.total.conversion.shareToOpened),
        ],
      ],
    ),
    "",
    "Получатели → регистрации (гости страниц по ссылке; подсказка: «сделали с ИИ и сохранили на Полку»)",
    table(
      [
        "Неделя",
        "Откр.",
        "Подск.",
        "Карт.",
        ...report.recipients.actions,
        "Наж.",
        "Рег.",
        "Подск→карт",
        "Карт→наж",
        "Наж→рег",
      ],
      [...report.recipients.weeks, { ...report.recipients.total, week: "Всего" }].map(
        (row) => [
          row.week,
          row.opened,
          row.barViews,
          row.cardViews,
          ...report.recipients.actions.map((action) => row.clicks[action]),
          row.clicksTotal,
          row.signups,
          percent(row.conversion.barToCard),
          percent(row.conversion.cardToClick),
          percent(row.conversion.clickToSignup),
        ],
      ),
    ),
    "",
    "Источники",
    table(
      ["Источник", "Посещения", "Регистрации", "Конверсия"],
      report.sources.map((source) => [
        source.source,
        source.visits,
        source.signups,
        percent(source.signupRate),
      ]),
    ),
    "",
    "Агенты",
    table(
      ["Клиент", "Подключений", "Аккаунтов"],
      report.agentClients.map((client: any) => [
        client.client,
        client.connections,
        client.accounts,
      ]),
    ),
    "",
    "Удержание (D1: день 1; D7: дни 7–13; D30: дни 30–36; «из» — у кого окно прошло)",
    table(
      ["Неделя", "Когорта", "D1", "из", "D7", "из", "D30", "из"],
      report.retention.map((cohort) => [
        cohort.week,
        cohort.cohort,
        percent(cohort.d1.rate),
        cohort.d1.eligible,
        percent(cohort.d7.rate),
        cohort.d7.eligible,
        percent(cohort.d30.rate),
        cohort.d30.eligible,
      ]),
    ),
    "",
    "Активность по неделям",
    table(
      [
        "Неделя",
        "Активных",
        "Посещ.",
        "Рег.",
        "Подкл.",
        "Сохр.",
        "Ссылки",
        "Откр.",
        "Заметки",
        "Заявки",
      ],
      report.activity.map((week) => [
        week.week,
        week.activeAccounts,
        week.pageViews,
        week.signups,
        week.agentConnections,
        week.saves,
        week.shares,
        week.sharesOpened,
        week.notes,
        week.enterpriseRequests,
      ]),
    ),
    "",
    `За всё время${report.totals.countingSince ? ` (с ${report.totals.countingSince})` : ""}`,
    table(
      ["Событие", "Число"],
      Object.entries(report.totals.allTime).map(([name, count]) => [
        name,
        count as number,
      ]),
    ),
  ];
  return out.join("\n");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An account by id, login or email; null when there is none. */
async function accountId(reference: string) {
  const {
    rows: [account],
  } = await db.query(
    UUID.test(reference)
      ? "SELECT id FROM accounts WHERE id=$1"
      : "SELECT id FROM accounts WHERE name=$1 OR email=lower($1)",
    [reference],
  );
  return (account?.id as string | undefined) ?? null;
}

export async function runMetricsCli(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      weeks: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const [command, reference, ...rest] = positionals;
  if (command === "forget") {
    if (!reference || rest.length) throw new Error(USAGE);
    // A deleted account's tombstone keeps its id, so an id is accepted as
    // given; a login or email must name an existing account.
    const id = UUID.test(reference) ? reference : await accountId(reference);
    if (!id) throw new Error("No such account.");
    const removed = await forgetAccount(db, id.toLowerCase(), true);
    return `Deleted ${removed.events} events and ${removed.activeDays} active days; new events of this account are not recorded.`;
  }
  if (command && command !== "summary") throw new Error(USAGE);
  const weeks = values.weeks === undefined ? 12 : Number(values.weeks);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 56)
    throw new Error("--weeks must be 1–56.");
  const report = await metricsReport({ weeks });
  return values.json ? JSON.stringify(report, null, 2) : formatReport(report);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(await runMetricsCli(process.argv.slice(2)));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
