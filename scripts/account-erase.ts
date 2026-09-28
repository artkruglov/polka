// Operator: erase an account on its owner's request (docs/legal/privacy.md
// § 7; apps/server/account-erase.ts). Runs where the purge worker may run:
// its database role and the erasure ledger come from the environment
// (MAINTENANCE_DATABASE_URL, ERASURE_LEDGER_*), see deploy/hosted/README.md.
//
//   account-erase.ts --account <login|email|id> --dry-run
//   account-erase.ts --account <login|email|id> --proof "обращение №1042" [--reason "…"]
//   account-erase.ts --account <login|email|id> --resume      # finish one that stopped
//
// The request closes the account at once (sign-in, agents, links); the
// worker then deletes every object version of the shelf, writes the ledger
// and erases the metadata. Prints counts and states, never content.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  erasureState,
  ErasureRefusal,
  requestAccountErasure,
  type ErasureReport,
} from "../apps/server/account-erase.ts";
import { flushAnalytics } from "../apps/server/analytics.ts";
import { findMergeAccount } from "../apps/server/account-merge.ts";
import { db } from "../apps/server/db.ts";
import { s3 } from "../apps/server/storage.ts";
import { runAccountPurgeCli } from "./account-purge-cli.ts";

const USAGE =
  'Usage: account-erase.ts --account <login|email|id> (--dry-run | --proof <номер обращения> [--reason "…"] | --resume) [--minutes 15] [--json]';

function policy(env: NodeJS.ProcessEnv) {
  const policyVersion = env.ACCOUNT_DELETION_POLICY_VERSION?.trim();
  const purgeMaxHours = Number(env.ACCOUNT_PURGE_MAX_HOURS);
  const backupRetentionMaxDays = Number(env.BACKUP_RETENTION_MAX_DAYS);
  if (
    !policyVersion ||
    !Number.isInteger(purgeMaxHours) || purgeMaxHours < 1 || purgeMaxHours > 8760 ||
    !Number.isInteger(backupRetentionMaxDays) || backupRetentionMaxDays < 0 || backupRetentionMaxDays > 3650
  )
    throw new ErasureRefusal(
      "Задайте ACCOUNT_DELETION_POLICY_VERSION, ACCOUNT_PURGE_MAX_HOURS (1–8760) и BACKUP_RETENTION_MAX_DAYS (0–3650): сроки, которые обещает Политика.",
    );
  return { policyVersion, purgeMaxHours, backupRetentionMaxDays };
}

function describe(report: ErasureReport) {
  const c = report.counts;
  return [
    `${report.dryRun ? "Пробный прогон" : "Удаление"}: ${report.account.name} (${report.account.id})`,
    `  работ ${c.works}, версий ${c.versions}, ${(c.bytes / 1048576).toFixed(1)} МБ; действующих ссылок ${c.activeLinks}, агентов ${c.agents}`,
    `  способов входа ${c.signInMethods}, библиотек шаблонов ${c.libraryMemberships}, полок отделов ${c.departmentShelves}, публикаций в «Ленте» ${c.editorialPublications}`,
    report.state === "would_request"
      ? "  Ничего не изменено. Для удаления: --proof <номер обращения>."
      : report.state === "requested"
        ? "  Доступ закрыт: вход, агенты, ссылки. Удаляю данные…"
        : `  Заявка уже есть: ${report.state}.`,
  ].join("\n");
}

/** Runs the purge worker until this account is purged, fails, or time is up. */
async function purge(accountId: string, minutes: number, env: NodeJS.ProcessEnv) {
  const until = Date.now() + minutes * 60_000;
  // The worker's own flag: the app keeps self-service deletion off.
  const workerEnv = { ...env, ACCOUNT_DELETION_ENABLED: "true" };
  let runs = 0;
  while (Date.now() < until) {
    const state = await erasureState(accountId);
    if (!state) return { state: "none" as const, runs };
    if (state.state === "purged") return { state: "purged" as const, runs };
    const exit = await runAccountPurgeCli({ env: workerEnv, emit: () => {} });
    runs++;
    if (exit !== 0) {
      const after = await erasureState(accountId);
      return { state: (after?.state ?? "none") as string, runs, error: after?.error_code ?? "worker" };
    }
    // A pass takes up to 100 versions of one shelf; the next one continues.
    // Another worker holding the guard also exits 0: wait rather than spin.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const state = await erasureState(accountId);
  return { state: state?.state ?? "none", runs, error: "time" };
}

export async function runAccountErase(argv: string[], env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      proof: { type: "string" },
      reason: { type: "string" },
      minutes: { type: "string", default: "15" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const minutes = Number(values.minutes);
  if (values.resume && values["dry-run"]) {
    console.error("--resume finishes a deletion that was requested: it cannot be a dry run.");
    return 2;
  }
  if (!values.account || !Number.isFinite(minutes) || minutes <= 0) {
    console.error(USAGE);
    return 2;
  }
  try {
    let accountId: string;
    if (values.resume) {
      const found = await findMergeAccount(values.account);
      if (!found) throw new ErasureRefusal(`Аккаунт не найден: ${values.account}`);
      accountId = found.id;
    } else {
      const report = await requestAccountErasure({
        account: values.account,
        dryRun: values["dry-run"],
        proof: values.proof,
        reason: values.reason,
        policy: policy(env),
      });
      if (!values.json) console.log(describe(report));
      await flushAnalytics();
      if (report.dryRun) {
        if (values.json) console.log(JSON.stringify(report, null, 2));
        return 0;
      }
      accountId = report.account.id;
    }
    const result = await purge(accountId, minutes, env);
    if (values.json) console.log(JSON.stringify({ accountId, ...result }, null, 2));
    else if (result.state === "purged")
      console.log(`Готово: данные удалены, запись в журнале стираний сделана (проходов: ${result.runs}).`);
    else
      console.log(
        `Не закончено: ${result.state}${"error" in result ? `, ${result.error}` : ""}. Доступ уже закрыт; продолжить — та же команда с --resume.`,
      );
    return result.state === "purged" ? 0 : 1;
  } catch (error) {
    if (error instanceof ErasureRefusal) {
      console.error(`Отказ: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runAccountErase(process.argv.slice(2));
  } finally {
    await db.end();
    s3.destroy();
  }
}
