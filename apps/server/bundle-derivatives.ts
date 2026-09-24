import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { PoolClient } from "pg";
import type { InlineBuildStatus } from "../../packages/contracts/index.ts";
import { canonicalizeManifest } from "../../packages/contracts/bundle.ts";
import { config } from "./config.ts";
import { assertActiveOwner, lockActiveOwnerTenant } from "./owner-state.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { readRevisionSource, type Actor } from "./artifacts.ts";
import { putImmutable, sha256 } from "./storage.ts";
import {
  BUILD_FAILURE_MESSAGES,
  BUILD_LIMITS,
  BUNDLE_BUILDER_VERSION,
  isServedRuntimeProfile,
  DERIVATIVE_BUILD_TIMEOUT_MS,
  DERIVATIVE_RESERVATION_BYTES,
  derivativePreferenceSql,
  derivativeVersionSql,
  type BuildFailureCategory,
} from "./bundle-runtime-contract.ts";

const BUILD_RETRY_COOLDOWN_MS = 30_000;
const BUILDER_FAILURES = new Set<string>(Object.values(BUILD_FAILURE_MESSAGES));

const activeBuilds = new Set<string>();

// A single HTML upload is built like a one-file bundle: its interactive
// version is how a page the static view cannot show gets a link.
const buildableStorage = (kind: string) =>
  kind === "bundle" || kind === "single";
let runningWorkers = 0;

export type DerivativeTransactionRunner = <T>(
  operation: (c: PoolClient) => Promise<T>,
) => Promise<T>;

const statusDTO = (row: any): InlineBuildStatus => ({
  state: row.state,
  runtimeProfile: row.runtime_profile ?? null,
  reason: row.reason ?? null,
  path: row.error_path ?? null,
});

export const inlineBuildSelect = `(
  SELECT jsonb_build_object(
    'state',d.state,
    'runtimeProfile',CASE WHEN d.state='ready' THEN d.runtime_profile ELSE NULL END,
    'reason',d.reason,
    'path',d.error_path
  )
  FROM revision_derivatives d
  WHERE d.revision_id=r.id
    AND d.source_manifest_sha256=r.manifest_sha256
    AND ${derivativeVersionSql("d")}
  ORDER BY ${derivativePreferenceSql("d")}
  LIMIT 1
) AS inline_build`;

function acquireWorkerSlot() {
  if (runningWorkers >= BUILD_LIMITS.workers) return false;
  runningWorkers++;
  return true;
}

function releaseWorkerSlot() {
  runningWorkers--;
}

// esbuild's memory is outside the worker heap: one runtime build at a time.
let runtimeBuildRunning = false;

export function acquireRuntimeSlot() {
  if (runtimeBuildRunning) return false;
  runtimeBuildRunning = true;
  return true;
}

export function releaseRuntimeSlot() {
  runtimeBuildRunning = false;
}

const runtimeBusy = () =>
  new Problem(
    429,
    "quota",
    "Сервер уже собирает другую страницу с компонентами. Повторите запрос через несколько секунд.",
  ).retryIn(5);

export type WorkerResult =
  | {
      ok: true;
      sourceManifestSha256: string;
      builderVersion: string;
      runtimeProfile: string;
      html: Uint8Array;
      sha256: string;
      size: number;
      warnings?: string[];
    }
  | {
      ok: false;
      reason: string;
      path?: string;
      // failed: the builder broke, not the page; busy: no runtime slot.
      failed?: boolean;
      category?: BuildFailureCategory;
      busy?: boolean;
    };

/** A build worker that did not answer: timed out, ran out of memory, died. */
export class BuildWorkerError extends Error {
  constructor(public category: BuildFailureCategory) {
    super(`Bundle build worker failed: ${category}`);
  }
}

/**
 * One line per builder failure: the category and stage only. Stored HTML,
 * paths and error text stay out of the logs.
 */
function logBuildFailure(category: string, stage: string) {
  console.error(
    JSON.stringify({
      event: "derivative.build.failed",
      category,
      stage,
      builderVersion: BUNDLE_BUILDER_VERSION,
    }),
  );
}

const requireFromHere = createRequire(import.meta.url);

/**
 * The only environment a build worker (and the esbuild it starts) gets:
 * never the server's own, which holds database and storage secrets. The
 * esbuild binary is started through a wrapper that sets a hard memory limit.
 */
export function builderEnv() {
  let binary = "";
  try {
    binary = requireFromHere.resolve(
      `@esbuild/${process.platform}-${process.arch}/bin/esbuild`,
    );
  } catch {
    // Without a platform binary the runtime build fails; classic builds run.
  }
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    GOMEMLIMIT: "256MiB",
    GOMAXPROCS: "2",
    ESBUILD_BINARY_PATH: fileURLToPath(
      new URL("./esbuild-limited.sh", import.meta.url),
    ),
    POLKA_ESBUILD_BINARY: binary,
  };
}

/**
 * Runs one build in a fresh worker under the heap limits and the build
 * deadline. The worker asks for the runtime slot itself (it classifies the
 * page); the slot is held until the worker ends.
 */
async function runBuilder(
  manifest: ReturnType<typeof canonicalizeManifest>,
  files: Array<{ path: string; bytes: Buffer }>,
) {
  return new Promise<WorkerResult>((resolve, reject) => {
    const worker = new Worker(
      new URL("./bundle-build-worker.mjs", import.meta.url),
      {
        resourceLimits: {
          maxOldGenerationSizeMb: BUILD_LIMITS.workerHeapMb,
          maxYoungGenerationSizeMb: BUILD_LIMITS.workerYoungMb,
          stackSizeMb: BUILD_LIMITS.workerStackMb,
        },
        // esbuild runs as a child process of this worker, inherits this
        // environment and ends with the worker.
        env: builderEnv(),
      },
    );
    let settled = false;
    let runtimeSlot = false;
    const settle = async (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await worker.terminate();
      if (runtimeSlot) releaseRuntimeSlot();
      runtimeSlot = false;
      outcome();
    };
    const timeout = setTimeout(
      () => void settle(() => reject(new BuildWorkerError("timeout"))),
      DERIVATIVE_BUILD_TIMEOUT_MS,
    );
    worker.on("message", (message: { type: string; result?: WorkerResult }) => {
      if (settled) return;
      if (message?.type === "runtime") {
        runtimeSlot = acquireRuntimeSlot();
        worker.postMessage(runtimeSlot);
        return;
      }
      void settle(() => resolve(message.result!));
    });
    worker.once("error", (error: Error & { code?: string }) => {
      void settle(() =>
        reject(
          new BuildWorkerError(
            error?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "oom" : "crash",
          ),
        ),
      );
    });
    worker.once("exit", () => {
      void settle(() => reject(new BuildWorkerError("crash")));
    });
    worker.postMessage({ manifest, files });
  });
}

/**
 * A build that is only a check (URL import): it waits a little for a free
 * worker instead of refusing, and never throws. A busy runtime slot or a
 * broken worker comes back as a refusal marked failed.
 */
export async function checkBuildInWorker(
  manifest: ReturnType<typeof canonicalizeManifest>,
  files: Array<{ path: string; bytes: Buffer }>,
  { waitMs = 10_000 }: { waitMs?: number } = {},
): Promise<WorkerResult> {
  const deadline = Date.now() + waitMs;
  while (!acquireWorkerSlot()) {
    if (Date.now() >= deadline)
      return {
        ok: false,
        failed: true,
        busy: true,
        reason: "сервер занят другими сборками",
      };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try {
    for (;;) {
      let result: WorkerResult;
      try {
        result = await runBuilder(manifest, files);
      } catch (error) {
        const category =
          error instanceof BuildWorkerError ? error.category : "crash";
        logBuildFailure(category, "check");
        return {
          ok: false,
          failed: true,
          category,
          reason: BUILD_FAILURE_MESSAGES[category],
        };
      }
      if (!result.ok && result.busy && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      if (!result.ok && result.failed)
        logBuildFailure(result.category ?? "crash", "check");
      return result;
    }
  } finally {
    releaseWorkerSlot();
  }
}

async function lockDerivative(
  c: PoolClient,
  tenantId: string,
  id: string,
  revisionId: string,
) {
  const {
    rows: [tenant],
  } = await c.query("SELECT * FROM tenants WHERE id=$1", [tenantId]);
  const {
    rows: [artifact],
  } = await c.query(
    `SELECT artifact.* FROM artifacts artifact
     JOIN revisions revision ON revision.artifact_id=artifact.id
     WHERE revision.id=$1 AND artifact.tenant_id=$2
     FOR UPDATE OF artifact`,
    [revisionId, tenantId],
  );
  const {
    rows: [row],
  } = await c.query(
    "SELECT * FROM revision_derivatives WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
    [id, tenantId],
  );
  return { tenant, artifact, row };
}

async function prepare(
  sourceTenantId: string,
  revisionId: string,
  runTransaction: DerivativeTransactionRunner,
) {
  return runTransaction(async (c) => {
    const {
      rows: [tenant],
    } = await c.query("SELECT * FROM tenants WHERE id=$1", [sourceTenantId]);
    const {
      rows: [revision],
    } = await c.query(
      `SELECT revision.*,artifact.lifecycle_version AS artifact_lifecycle_version
       FROM revisions revision
       JOIN artifacts artifact ON artifact.id=revision.artifact_id
       WHERE revision.id=$1 AND revision.tenant_id=$2
         AND artifact.trashed_at IS NULL
       FOR UPDATE OF artifact`,
      [revisionId, sourceTenantId],
    );
    if (
      !revision ||
      !buildableStorage(revision.storage_kind) ||
      revision.mime !== "text/html" ||
      !revision.manifest_sha256
    )
      throw missing();
    // A ready derivative of an older served builder keeps serving; it is not
    // rebuilt. Otherwise only the current builder's row is considered.
    const {
      rows: [existing],
    } = await c.query(
      `SELECT * FROM revision_derivatives d
       WHERE revision_id=$1 AND source_manifest_sha256=$2
         AND ${derivativeVersionSql("d")}
       ORDER BY ${derivativePreferenceSql("d")}
       LIMIT 1
       FOR UPDATE`,
      [revisionId, revision.manifest_sha256],
    );
    if (existing && ["ready", "unsupported"].includes(existing.state))
      return { row: existing, run: false };
    // A build the builder itself gave up on (timeout, out of memory, crash)
    // is the expensive kind; a client retrying it in a loop would hold the
    // process's build slots for every other owner, so the same source is not
    // rebuilt for a while. An attempt that never ran (abandoned, then failed
    // by maintenance) or failed to store is retried at once.
    if (
      existing?.state === "failed" &&
      BUILDER_FAILURES.has(existing.reason) &&
      Date.now() - new Date(existing.updated_at).getTime() <
        BUILD_RETRY_COOLDOWN_MS
    )
      return { row: existing, run: false };
    if (existing?.state === "pending")
      return {
        row: existing,
        run:
          Number(existing.artifact_lifecycle_version) ===
            Number(revision.artifact_lifecycle_version) &&
          new Date(existing.attempt_expires_at).getTime() > Date.now(),
      };
    const {
      rows: [pending],
    } = await c.query(
      "SELECT count(*) AS count FROM revision_derivatives WHERE tenant_id=$1 AND state='pending'",
      [sourceTenantId],
    );
    if (
      Number(pending.count) >= 2 ||
      Number(tenant.derivative_used_bytes) +
        (Number(pending.count) + 1) * DERIVATIVE_RESERVATION_BYTES >
        Number(tenant.derivative_quota_bytes)
    )
      throw new Problem(
        413,
        "quota",
        "Достигнут лимит собранных страниц или одновременных сборок.",
      );
    const attemptId = randomUUID();
    if (existing) {
      const {
        rows: [row],
      } = await c.query(
        `UPDATE revision_derivatives
         SET state='pending',attempt_id=$2,attempt_expires_at=now()+interval '5 minutes',
             runtime_profile=NULL,size=NULL,sha256=NULL,object_key=NULL,object_version=NULL,
             reason=NULL,error_path=NULL,artifact_lifecycle_version=$3,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [existing.id, attemptId, revision.artifact_lifecycle_version],
      );
      return { row, run: true };
    }
    const {
      rows: [row],
    } = await c.query(
      `INSERT INTO revision_derivatives(
         id,tenant_id,revision_id,source_manifest_sha256,builder_version,state,
         attempt_id,attempt_expires_at,artifact_lifecycle_version
       ) VALUES($1,$2,$3,$4,$5,'pending',$6,now()+interval '5 minutes',$7)
       RETURNING *`,
      [
        randomUUID(),
        sourceTenantId,
        revisionId,
        revision.manifest_sha256,
        BUNDLE_BUILDER_VERSION,
        attemptId,
        revision.artifact_lifecycle_version,
      ],
    );
    return { row, run: true };
  });
}

async function finishNonReady(
  sourceTenantId: string,
  derivative: any,
  state: "unsupported" | "failed",
  reason: string,
  runTransaction: DerivativeTransactionRunner,
  errorPath?: string,
) {
  return runTransaction(async (c) => {
    const { artifact, row } = await lockDerivative(
      c,
      sourceTenantId,
      derivative.id,
      derivative.revision_id,
    );
    if (
      !row ||
      !artifact ||
      artifact.trashed_at ||
      Number(artifact.lifecycle_version) !==
        Number(row.artifact_lifecycle_version) ||
      row.state !== "pending" ||
      row.attempt_id !== derivative.attempt_id
    )
      return row;
    const {
      rows: [updated],
    } = await c.query(
      `UPDATE revision_derivatives
       SET state=$3,attempt_expires_at=NULL,reason=$4,error_path=$5,updated_at=now()
       WHERE id=$1 AND attempt_id=$2 RETURNING *`,
      [
        derivative.id,
        derivative.attempt_id,
        state,
        reason.slice(0, 300),
        errorPath?.slice(0, 300) ?? null,
      ],
    );
    return updated;
  });
}

async function executeBuild(
  sourceTenantId: string,
  derivative: any,
  runTransaction: DerivativeTransactionRunner,
  readSource: () => ReturnType<typeof readRevisionSource>,
) {
  // Every outcome ends this attempt (a resumed one too); finishNonReady
  // changes only the row still pending under this attempt_id.
  const finish = async (
    state: "unsupported" | "failed",
    reason: string,
    errorPath?: string,
  ) => {
    const row = await finishNonReady(
      sourceTenantId,
      derivative,
      state,
      reason,
      runTransaction,
      errorPath,
    );
    if (!row) throw missing();
    return statusDTO(row);
  };
  let source: Awaited<ReturnType<typeof readRevisionSource>>;
  let result: WorkerResult;
  try {
    source = await readSource();
    if (!buildableStorage(source.revision.storage_kind)) throw missing();
    if (source.manifestSha256 !== derivative.source_manifest_sha256)
      throw new Error("Derivative source changed");
    result = await runBuilder(source.manifest, source.files);
  } catch (error) {
    const category = error instanceof BuildWorkerError ? error.category : null;
    logBuildFailure(category ?? "internal", "build");
    return finish(
      "failed",
      category
        ? BUILD_FAILURE_MESSAGES[category]
        : "Не удалось безопасно собрать страницу.",
    );
  }
  if (!result.ok) {
    // esbuild runs outside the worker heap, so runtime pages are admitted
    // one at a time; the row stays pending and a retry resumes it.
    if (result.busy) throw runtimeBusy();
    if (result.failed) logBuildFailure(result.category ?? "crash", "build");
    return finish(
      result.failed ? "failed" : "unsupported",
      result.reason,
      result.path,
    );
  }
  const built = result;
  const objectKey = `${sourceTenantId}/derivatives/${derivative.id}/${derivative.attempt_id}.html`;
  let ready: any;
  try {
    if (
      built.sourceManifestSha256 !== derivative.source_manifest_sha256 ||
      built.builderVersion !== BUNDLE_BUILDER_VERSION ||
      !isServedRuntimeProfile(built.runtimeProfile) ||
      built.size > DERIVATIVE_RESERVATION_BYTES ||
      sha256(built.html) !== built.sha256
    )
      throw new Error("Bundle builder result invariant failed");
    ready = await runTransaction(async (c) => {
      const { tenant, artifact, row } = await lockDerivative(
        c,
        sourceTenantId,
        derivative.id,
        derivative.revision_id,
      );
      if (
        !row ||
        !artifact ||
        artifact.trashed_at ||
        Number(artifact.lifecycle_version) !==
          Number(row.artifact_lifecycle_version) ||
        row.state !== "pending" ||
        row.attempt_id !== derivative.attempt_id ||
        new Date(row.attempt_expires_at).getTime() <= Date.now()
      )
        return row;
      const {
        rows: [pending],
      } = await c.query(
        "SELECT count(*) AS count FROM revision_derivatives WHERE tenant_id=$1 AND state='pending' AND id<>$2",
        [sourceTenantId, derivative.id],
      );
      if (
        Number(tenant.derivative_used_bytes) +
          Number(pending.count) * DERIVATIVE_RESERVATION_BYTES +
          built.size >
        Number(tenant.derivative_quota_bytes)
      )
        throw new Problem(
          413,
          "quota",
          "Недостаточно места для собранной страницы.",
        );
      const objectVersion = await putImmutable(
        objectKey,
        Buffer.from(built.html),
      );
      await c.query(
        "UPDATE tenants SET derivative_used_bytes=derivative_used_bytes+$2 WHERE id=$1",
        [sourceTenantId, built.size],
      );
      // A ready row's reason lists what the builder left out, if anything.
      const warnings = built.warnings?.length
        ? `Пропущено: ${built.warnings.join("; ")}`
        : null;
      const {
        rows: [updated],
      } = await c.query(
        `UPDATE revision_derivatives
         SET state='ready',attempt_expires_at=NULL,runtime_profile=$3,size=$4,sha256=$5,
             object_key=$6,object_version=$7,reason=$8,error_path=NULL,updated_at=now()
         WHERE id=$1 AND attempt_id=$2 RETURNING *`,
        [
          derivative.id,
          derivative.attempt_id,
          built.runtimeProfile,
          built.size,
          built.sha256,
          objectKey,
          objectVersion,
          warnings?.slice(0, 300) ?? null,
        ],
      );
      return updated;
    });
  } catch (error) {
    // Quota, storage or invariant: the attempt ends as failed (retryable)
    // instead of staying pending until it expires.
    const quota = error instanceof Problem && error.status === 413;
    logBuildFailure(quota ? "quota" : "store", "finish");
    return finish(
      "failed",
      quota
        ? error.message
        : "Не удалось сохранить собранную страницу. Повторите подготовку.",
    );
  }
  return statusDTO(ready);
}

export async function getInlineBuildStatus(actor: Actor, revisionId: string) {
  if (!config.HTML_LIVE_ENABLED) throw missing();
  await assertActiveOwner(db, actor);
  const {
    rows: [revision],
  } = await db.query(
    `SELECT revision.storage_kind,revision.manifest_sha256
     FROM revisions revision JOIN artifacts artifact ON artifact.id=revision.artifact_id
     WHERE revision.id=$1 AND revision.tenant_id=$2 AND artifact.trashed_at IS NULL`,
    [revisionId, actor.tenant],
  );
  if (!revision) throw missing();
  if (!buildableStorage(revision.storage_kind) || !revision.manifest_sha256)
    return null;
  const {
    rows: [row],
  } = await db.query(
    `SELECT * FROM revision_derivatives d
     WHERE revision_id=$1 AND source_manifest_sha256=$2
       AND ${derivativeVersionSql("d")}
     ORDER BY ${derivativePreferenceSql("d")}
     LIMIT 1`,
    [revisionId, revision.manifest_sha256],
  );
  return row ? statusDTO(row) : null;
}

export async function buildInlineRevision(actor: Actor, revisionId: string) {
  if (!config.HTML_LIVE_ENABLED) throw missing();
  return buildInlineRevisionWithRunner(
    actor,
    revisionId,
    ownerTransactionRunner(actor),
  );
}

function ownerTransactionRunner(actor: Actor): DerivativeTransactionRunner {
  return (operation) =>
    transaction(async (c) => {
      await lockActiveOwnerTenant(
        c,
        actor,
        () => new Problem(403, "forbidden", "Доступ к аккаунту закрыт."),
      );
      return operation(c);
    });
}

export async function buildInlineRevisionWithRunner(
  actor: Actor,
  revisionId: string,
  runTransaction: DerivativeTransactionRunner,
) {
  return buildInlineRevisionFromSource({
    sourceTenantId: actor.tenant,
    revisionId,
    runTransaction,
    readSource: () => readRevisionSource(actor, revisionId),
  });
}

export async function buildInlineRevisionFromSource({
  sourceTenantId,
  revisionId,
  runTransaction,
  readSource,
}: {
  sourceTenantId: string;
  revisionId: string;
  runTransaction: DerivativeTransactionRunner;
  readSource: () => ReturnType<typeof readRevisionSource>;
}) {
  if (!config.HTML_LIVE_ENABLED) throw missing();
  const prepared = await prepare(sourceTenantId, revisionId, runTransaction);
  if (!prepared.run)
    return { status: statusDTO(prepared.row), concurrent: false };
  if (activeBuilds.has(prepared.row.id))
    return { status: statusDTO(prepared.row), concurrent: true };
  if (!acquireWorkerSlot())
    throw new Problem(
      429,
      "quota",
      "Сервер уже собирает другие страницы. Повторите запрос.",
    ).retryIn(5);
  activeBuilds.add(prepared.row.id);
  try {
    return {
      status: await executeBuild(
        sourceTenantId,
        prepared.row,
        runTransaction,
        readSource,
      ),
      concurrent: false,
    };
  } finally {
    activeBuilds.delete(prepared.row.id);
    releaseWorkerSlot();
  }
}
