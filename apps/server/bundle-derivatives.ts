import { randomUUID } from "node:crypto";
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
  BUNDLE_BUILDER_VERSION,
  BUNDLE_RUNTIME_PROFILE,
  DERIVATIVE_BUILD_TIMEOUT_MS,
  DERIVATIVE_RESERVATION_BYTES,
} from "./bundle-runtime-contract.ts";

const activeBuilds = new Set<string>();
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
    AND d.builder_version='${BUNDLE_BUILDER_VERSION}'
  LIMIT 1
) AS inline_build`;

function acquireWorkerSlot() {
  if (runningWorkers >= 2) return false;
  runningWorkers++;
  return true;
}

function releaseWorkerSlot() {
  runningWorkers--;
}

type WorkerResult =
  | {
      ok: true;
      sourceManifestSha256: string;
      builderVersion: string;
      runtimeProfile: string;
      html: Uint8Array;
      sha256: string;
      size: number;
    }
  | { ok: false; reason: string; path?: string; failed?: boolean };

async function runBuilder(
  manifest: ReturnType<typeof canonicalizeManifest>,
  files: Array<{ path: string; bytes: Buffer }>,
) {
  return new Promise<WorkerResult>((resolve, reject) => {
    const worker = new Worker(
      new URL("./bundle-build-worker.mjs", import.meta.url),
      {
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      },
    );
    let settled = false;
    const timeout = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await worker.terminate();
      reject(new Error("Bundle build deadline exceeded"));
    }, DERIVATIVE_BUILD_TIMEOUT_MS);
    worker.once("message", async (result: WorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await worker.terminate();
      resolve(result);
    });
    worker.once("error", async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await worker.terminate();
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Bundle build worker exited with code ${code}`));
    });
    worker.postMessage({ manifest, files });
  });
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
      revision.storage_kind !== "bundle" ||
      revision.mime !== "text/html" ||
      !revision.manifest_sha256
    )
      throw missing();
    const {
      rows: [existing],
    } = await c.query(
      `SELECT * FROM revision_derivatives
       WHERE revision_id=$1 AND source_manifest_sha256=$2 AND builder_version=$3
       FOR UPDATE`,
      [revisionId, revision.manifest_sha256, BUNDLE_BUILDER_VERSION],
    );
    if (existing && ["ready", "unsupported"].includes(existing.state))
      return { row: existing, run: false, resumed: false };
    if (existing?.state === "pending")
      return {
        row: existing,
        run:
          Number(existing.artifact_lifecycle_version) ===
            Number(revision.artifact_lifecycle_version) &&
          new Date(existing.attempt_expires_at).getTime() > Date.now(),
        resumed: true,
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
      return { row, run: true, resumed: false };
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
    return { row, run: true, resumed: false };
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
  resumed: boolean,
  runTransaction: DerivativeTransactionRunner,
  readSource: () => ReturnType<typeof readRevisionSource>,
) {
  let source: Awaited<ReturnType<typeof readRevisionSource>>;
  let result: WorkerResult;
  try {
    source = await readSource();
    if (source.revision.storage_kind !== "bundle") throw missing();
    if (source.manifestSha256 !== derivative.source_manifest_sha256)
      throw new Error("Derivative source changed");
    result = await runBuilder(source.manifest, source.files);
  } catch (error) {
    if (resumed) throw error;
    const failed = await finishNonReady(
      sourceTenantId,
      derivative,
      "failed",
      "Не удалось безопасно собрать страницу.",
      runTransaction,
    );
    if (!failed) throw error;
    return statusDTO(failed);
  }
  if (!result.ok) {
    if (resumed) return statusDTO(derivative);
    return statusDTO(
      await finishNonReady(
        sourceTenantId,
        derivative,
        result.failed ? "failed" : "unsupported",
        result.reason,
        runTransaction,
        result.path,
      ),
    );
  }
  if (
    result.sourceManifestSha256 !== derivative.source_manifest_sha256 ||
    result.builderVersion !== BUNDLE_BUILDER_VERSION ||
    result.runtimeProfile !== BUNDLE_RUNTIME_PROFILE ||
    result.size > DERIVATIVE_RESERVATION_BYTES ||
    sha256(result.html) !== result.sha256
  )
    throw new Error("Bundle builder result invariant failed");
  const objectKey = `${sourceTenantId}/derivatives/${derivative.id}/${derivative.attempt_id}.html`;
  const ready = await runTransaction(async (c) => {
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
        result.size >
      Number(tenant.derivative_quota_bytes)
    )
      throw new Problem(
        413,
        "quota",
        "Недостаточно места для собранной страницы.",
      );
    const objectVersion = await putImmutable(
      objectKey,
      Buffer.from(result.html),
    );
    await c.query(
      "UPDATE tenants SET derivative_used_bytes=derivative_used_bytes+$2 WHERE id=$1",
      [sourceTenantId, result.size],
    );
    const {
      rows: [updated],
    } = await c.query(
      `UPDATE revision_derivatives
       SET state='ready',attempt_expires_at=NULL,runtime_profile=$3,size=$4,sha256=$5,
           object_key=$6,object_version=$7,reason=NULL,error_path=NULL,updated_at=now()
       WHERE id=$1 AND attempt_id=$2 RETURNING *`,
      [
        derivative.id,
        derivative.attempt_id,
        BUNDLE_RUNTIME_PROFILE,
        result.size,
        result.sha256,
        objectKey,
        objectVersion,
      ],
    );
    return updated;
  });
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
  if (revision.storage_kind !== "bundle") return null;
  const {
    rows: [row],
  } = await db.query(
    `SELECT * FROM revision_derivatives
     WHERE revision_id=$1 AND source_manifest_sha256=$2 AND builder_version=$3`,
    [revisionId, revision.manifest_sha256, BUNDLE_BUILDER_VERSION],
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
    );
  activeBuilds.add(prepared.row.id);
  try {
    return {
      status: await executeBuild(
        sourceTenantId,
        prepared.row,
        prepared.resumed,
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
