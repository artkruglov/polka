import type { PoolClient } from "pg";
import { transaction } from "../db.ts";
import {
  captureForOwner,
  captureFromAgent,
  type CaptureHooks,
} from "../agent-capture.ts";
import { MCP_AUDIENCE } from "../service-auth.ts";
import type { Actor } from "../artifacts.ts";
import { captureHtmlUrl, HtmlCaptureError } from "./html-capture.ts";
import { prepareImport } from "./prepare.ts";
import { ImportFetchError } from "./public-fetch.ts";
import { authorizeImport, claimImportJob, requireImportLease } from "./jobs.ts";
import { buildInlineRevisionWithRunner } from "../bundle-derivatives.ts";
import { config } from "../config.ts";
import { Problem } from "../errors.ts";

type Run = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;
type Prepared = Awaited<ReturnType<typeof captureHtmlUrl>>;
type Save = (
  actor: Actor,
  body: unknown,
  hooks: CaptureHooks,
) => Promise<unknown>;
const save: Save = (actor, body, hooks) =>
  actor.connectionId
    ? captureFromAgent(
        {
          accountId: actor.id,
          tenantId: actor.tenant,
          connectionId: actor.connectionId,
          audience: MCP_AUDIENCE,
          scopes: [],
          expiresAt: 0,
        },
        body,
        "capture",
        hooks,
      )
    : captureForOwner(actor, body, hooks);
/** One durable job per call. Scheduling is separate; no secrets or raw errors in logs. */
export async function runImportOnce({
  run = transaction,
  prepare = prepareImport,
  persist = save,
}: {
  run?: Run;
  prepare?: (url: string) => Promise<Prepared>;
  persist?: Save;
} = {}) {
  const job = await run(claimImportJob);
  if (!job) return false;
  const actor: Actor = {
    id: job.account_id,
    tenant: job.tenant_id,
    ...(job.connection_id ? { connectionId: job.connection_id } : {}),
  };
  const guard = async (c: PoolClient) => {
    await authorizeImport(c, actor);
    await requireImportLease(c, job.id, job.lease_token);
  };
  try {
    await run(guard);
    if (job.receipt) {
      // A committed copy survives process death. Retry builds from stored files,
      // never by downloading a potentially changed source.
      const built = config.HTML_LIVE_ENABLED
        ? await buildInlineRevisionWithRunner(
            actor,
            job.receipt.revisionId,
            (fn) =>
              run(async (c) => {
                await guard(c);
                return fn(c);
              }),
          )
        : null;
      if (built?.status.state === "pending") return true; // Keep lease until retry; no tight loop.
      await run(async (c) => {
        await guard(c);
        await c.query(
          "UPDATE url_import_jobs SET state=$3,error_code=$4,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",
          [
            job.id,
            job.lease_token,
            built?.status.state === "ready" ? "ready" : "partial",
            built?.status.state === "ready"
              ? null
              : config.HTML_LIVE_ENABLED
                ? "preview_unavailable"
                : "preview_disabled",
          ],
        );
      });
      return true;
    }
    // Recheck before downloading, including revocation since enqueue.
    let prepared: Prepared = job.prepared;
    if (!prepared) {
      prepared = await prepare(job.request.url);
      await run(async (c) => {
        await guard(c);
        await c.query(
          "UPDATE url_import_jobs SET prepared=$2,warnings=$3,state='prepared',updated_at=now() WHERE id=$1",
          [job.id, prepared, JSON.stringify(prepared.warnings)],
        );
      });
    }
    await run(async (c) => {
      await guard(c);
      await c.query(
        "UPDATE url_import_jobs SET state='saving',updated_at=now(),lease_until=now()+interval '2 minutes' WHERE id=$1",
        [job.id],
      );
    });
    await persist(
      actor,
      {
        key: job.id,
        title: job.request.title ?? prepared.title,
        ...(job.request.folderId ? { folderId: job.request.folderId } : {}),
        manifest: prepared.manifest,
        files: prepared.files,
      },
      {
        beforeStep: guard,
        afterSave: async (c, receipt) => {
          // Invoked in the same transaction as upload finalization. A cancellation
          // either wins before this lock or sees a finished receipt; never both.
          await requireImportLease(c, job.id, job.lease_token);
          await c.query(
            "UPDATE url_import_jobs SET state=$2,receipt=$3,prepared=NULL,lease_token=NULL,lease_until=NULL,attempts=0,error_code=CASE WHEN $2='partial' THEN 'preview_unavailable' ELSE NULL END,updated_at=now() WHERE id=$1",
            [
              job.id,
              prepared.previewReady && config.HTML_LIVE_ENABLED
                ? "previewing"
                : "partial",
              receipt,
            ],
          );
        },
      },
    );
  } catch (error) {
    const code =
      error instanceof ImportFetchError || error instanceof HtmlCaptureError
        ? error.code
        : error instanceof Problem
          ? error.code
          : "internal";
    // Fenced update: a cancelled, reassigned or completed job is never overwritten.
    await run(async (c) => {
      await c.query(
        "UPDATE url_import_jobs SET state=CASE WHEN receipt IS NULL THEN 'failed' ELSE 'partial' END,error_code=$3,lease_token=NULL,lease_until=NULL,prepared=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state IN ('fetching','prepared','saving','previewing')",
        [job.id, job.lease_token, code],
      );
    });
  }
  return true;
}
/** Exhausted/dead jobs cannot remain pending forever. Final receipt and job state
 * are committed together, so there is no saved-but-unreported job to discard. */
export async function expireImportJobs(run: Run = transaction) {
  return run(
    async (c) =>
      (
        await c.query(
          "UPDATE url_import_jobs SET state=CASE WHEN receipt IS NULL THEN 'failed' ELSE 'partial' END,error_code=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'retry_exhausted' END,prepared=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE state IN ('queued','fetching','prepared','saving','previewing') AND (lease_until IS NULL OR lease_until<now()) AND (expires_at<=now() OR attempts>=3)",
        )
      ).rowCount ?? 0,
  );
}
