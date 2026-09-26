import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createApp } from "../apps/server/app.ts";
import {
  accountDeletionStatus,
  confirmAccountDeletion,
  type AccountDeletionReceipt,
} from "../apps/server/account-deletion.ts";
import { actorKey, flushAnalytics } from "../apps/server/analytics.ts";
import { beginUpload } from "../apps/server/artifacts.ts";
import { createAccount, signIn } from "../apps/server/auth.ts";
import { buildInlineRevisionWithRunner } from "../apps/server/bundle-derivatives.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { Problem } from "../apps/server/errors.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import { lockActiveOwnerTenant } from "../apps/server/owner-state.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
  recheckServiceActor,
} from "../apps/server/service-auth.ts";
import { readBlob, s3, sha256 } from "../apps/server/storage.ts";
import { prepareCapture } from "../scripts/prepare-capture.ts";

const testRunId = process.env.R17_TEST_RUN_ID ?? "";
const expectedDatabase = `polka_r17_test_${testRunId}`;
const expectedBucket = `polka-r17-test-${testRunId}`;
const databaseUrl = new URL(process.env.DATABASE_URL ?? "http://invalid");
const storageUrl = new URL(process.env.S3_ENDPOINT ?? "http://invalid");
if (
  !/^[a-z0-9]{10,24}$/.test(testRunId) ||
  !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
  databaseUrl.search ||
  databaseUrl.hash ||
  decodeURIComponent(databaseUrl.pathname.slice(1)) !== expectedDatabase ||
  !["127.0.0.1", "localhost"].includes(storageUrl.hostname) ||
  storageUrl.origin !== process.env.S3_ENDPOINT ||
  storageUrl.port !== "9038" ||
  process.env.S3_ACCESS_KEY !== "polka-local" ||
  process.env.S3_BUCKET !== expectedBucket
)
  throw new Error("Account deletion tests require a guarded isolated target");
if (!config.ACCOUNT_DELETION_ENABLED)
  throw new Error(
    "Run account-deletion.test.ts with ACCOUNT_DELETION_ENABLED=true and explicit local policy settings",
  );
if (!config.HTML_LIVE_ENABLED)
  throw new Error("Run account-deletion.test.ts with HTML_LIVE_ENABLED=true");

const expectedSentinel = `polka-r17-test:${testRunId}`;
const databaseIdentity = (
  await db.query(
    `SELECT shobj_description(oid,'pg_database') AS value,
            current_user,session_user
     FROM pg_database WHERE datname=current_database()`,
  )
).rows[0];
const databaseSentinel = databaseIdentity?.value;
const storedSentinel = await s3.send(
  new GetObjectCommand({ Bucket: expectedBucket, Key: ".polka-r17-test" }),
);
const bucketSentinel = Buffer.from(
  await storedSentinel.Body!.transformToByteArray(),
).toString("utf8");
if (
  databaseSentinel !== expectedSentinel ||
  bucketSentinel !== expectedSentinel
)
  throw new Error("Account deletion test sentinel mismatch");
if (
  process.env.RUNTIME_GRANTS_EXPECT_ROLE &&
  (databaseIdentity?.current_user !== process.env.RUNTIME_GRANTS_EXPECT_ROLE ||
    databaseIdentity?.session_user !== process.env.RUNTIME_GRANTS_EXPECT_ROLE)
)
  throw new Error("Account deletion test did not use the runtime role");

const app = await createApp();
const viewer = await createLiveViewerApp();
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let neighbor: Awaited<ReturnType<typeof createAccount>>;
let ownerCookie = "";
let neighborCookie = "";

async function call(
  method: any,
  url: string,
  body?: any,
  cookie = ownerCookie,
  csrf?: string,
  authorization?: string,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.APP_ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-polka-csrf": csrf } : {}),
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      ...(Buffer.isBuffer(body)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    payload: body,
  });
}

async function login(account: typeof owner) {
  const response = await call(
    "POST",
    "/api/login",
    { name: account.name, password },
    "",
  );
  assert.equal(response.statusCode, 200, response.body);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

async function saveSingle(cookie = ownerCookie, title = "Deletion fixture") {
  const bytes = Buffer.from("<!doctype html><h1>deletion fixture</h1>");
  const begun = await call(
    "POST",
    "/api/uploads",
    {
      key: randomUUID(),
      title,
      filename: "index.html",
      mime: "text/html",
      size: bytes.length,
      sha256: sha256(bytes),
    },
    cookie,
  );
  assert.equal(begun.statusCode, 200, begun.body);
  const { uploadId } = begun.json();
  assert.equal(
    (await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes, cookie))
      .statusCode,
    200,
  );
  const finalized = await call(
    "POST",
    `/api/uploads/${uploadId}/finalize`,
    {},
    cookie,
  );
  assert.equal(finalized.statusCode, 200, finalized.body);
  return { ...finalized.json(), bytes } as any;
}

async function saveBundle() {
  const prepared = await prepareCapture(
    "tests/fixtures/bundle-corpus/team-report",
    "index.html",
    ["index.html", "assets/report.css", "assets/report.js", "assets/mark.svg"],
  );
  const begun = await call("POST", "/api/bundle-uploads", {
    key: randomUUID(),
    title: "Deletion bundle fixture",
    manifest: prepared.manifest,
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const { uploadId, manifest } = begun.json();
  for (const [index, file] of manifest.files.entries()) {
    const supplied = prepared.files.find((item) => item.path === file.path)!;
    const uploaded = await call(
      "PUT",
      `/api/bundle-uploads/${uploadId}/files/${index}`,
      Buffer.from(supplied.data, supplied.encoding),
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
  }
  const finalized = await call(
    "POST",
    `/api/bundle-uploads/${uploadId}/finalize`,
    {},
  );
  assert.equal(finalized.statusCode, 200, finalized.body);
  return finalized.json() as any;
}

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`delete-a-${suffix}`, password);
  neighbor = await createAccount(`delete-b-${suffix}`, password);
  ownerCookie = await login(owner);
  neighborCookie = await login(neighbor);
});

after(async () => {
  await Promise.allSettled([app.close(), viewer.close()]);
  await db.end();
  s3.destroy();
});

test("confirmed deletion atomically closes access while preserving source data for a future purge", async () => {
  const actor = { id: owner.id, tenant: owner.tenant };
  const sessionToken = ownerCookie.split("=")[1];
  const single = await saveSingle();
  const neighborSingle = await saveSingle(
    neighborCookie,
    "Neighbor deletion control",
  );
  const neighborShared = await call(
    "POST",
    `/api/artifacts/${neighborSingle.artifactId}/share`,
    {
      expectedRevisionId: neighborSingle.revisionId,
      expiresInDays: 7,
    },
    neighborCookie,
  );
  assert.equal(neighborShared.statusCode, 200, neighborShared.body);
  const neighborShareToken = new URL(
    neighborShared.json().share.url,
  ).hash.slice(1);
  const bundle = await saveBundle();
  const source = (
    await db.query("SELECT * FROM revisions WHERE id=$1", [single.revisionId])
  ).rows[0];
  const sourceBytesBefore = await readBlob(
    source.object_key,
    source.object_version,
  );
  const quotaBefore = (
    await db.query(
      "SELECT used_bytes,derivative_used_bytes FROM tenants WHERE id=$1",
      [owner.tenant],
    )
  ).rows[0];

  const shared = await call(
    "POST",
    `/api/artifacts/${single.artifactId}/share`,
    {
      expectedRevisionId: single.revisionId,
      expiresInDays: 7,
    },
  );
  assert.equal(shared.statusCode, 200, shared.body);
  const share = shared.json().share;
  const shareToken = new URL(share.url).hash.slice(1);
  const resolved = await call(
    "POST",
    "/api/resolve",
    { token: shareToken },
    "",
  );
  assert.equal(resolved.statusCode, 200, resolved.body);
  const grant = resolved.json().grant as string;
  const live = await call(
    "POST",
    `/api/revisions/${single.revisionId}/live-view`,
    {},
  );
  assert.equal(live.statusCode, 200, live.body);
  const viewerToken = new URL(live.json().url).pathname.split("/").at(-1)!;

  const connectionCsrf = await call("POST", "/api/agent-connections/csrf", {});
  const issued = await call(
    "POST",
    "/api/agent-connections",
    {
      name: "Deletion test connection",
      scopes: ["context", "capture"],
      audience: MCP_AUDIENCE,
    },
    ownerCookie,
    connectionCsrf.json().csrfToken,
  );
  assert.equal(issued.statusCode, 200, issued.body);
  const serviceToken = issued.json().token as string;
  const cachedServiceActor = await authenticateServiceToken(
    serviceToken,
    MCP_AUDIENCE,
    "context",
  );

  const pending = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Pending deletion upload",
    filename: "pending.txt",
    mime: "text/plain",
    size: 1,
    sha256: sha256(Buffer.from("x")),
  });
  assert.equal(pending.statusCode, 200, pending.body);

  const deletionCsrf = await call("POST", "/api/account/deletion-csrf", {});
  assert.equal(deletionCsrf.statusCode, 200, deletionCsrf.body);
  const csrf = deletionCsrf.json().csrfToken as string;
  assert.equal(
    (await call("POST", "/api/account/deletion-plan", {}, ownerCookie))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/account/deletion-plan",
        {},
        ownerCookie,
        randomBytes(32).toString("base64url"),
      )
    ).statusCode,
    403,
  );
  const firstPlan = await call(
    "POST",
    "/api/account/deletion-plan",
    {},
    ownerCookie,
    csrf,
  );
  assert.equal(firstPlan.statusCode, 200, firstPlan.body);
  const first = firstPlan.json();
  assert.match(first.statusCapability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.purgeAvailable, false);
  assert.equal(
    first.provisionalPolicy.policyVersion,
    config.ACCOUNT_DELETION_POLICY_VERSION,
  );

  const secondPlan = await call(
    "POST",
    "/api/account/deletion-plan",
    {},
    ownerCookie,
    csrf,
  );
  assert.equal(secondPlan.statusCode, 200, secondPlan.body);
  const second = secondPlan.json();
  assert.notEqual(second.planId, first.planId);
  assert.notEqual(second.statusCapability, first.statusCapability);
  assert.equal(
    (
      await call(
        "POST",
        "/api/account/deletion-status",
        {
          capability: first.statusCapability,
        },
        "",
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/account/deletion",
        {
          planId: first.planId,
          expectedAccountId: owner.id,
          expectedTenantId: owner.tenant,
          confirmation: "DELETE",
        },
        ownerCookie,
        csrf,
      )
    ).statusCode,
    409,
  );

  let releaseReady!: () => void;
  let reachedReady!: () => void;
  const readyReached = new Promise<void>((resolve) => (reachedReady = resolve));
  const readyRelease = new Promise<void>((resolve) => (releaseReady = resolve));
  let transactions = 0;
  const build = buildInlineRevisionWithRunner(
    actor,
    bundle.revisionId,
    async (operation) => {
      transactions++;
      if (transactions === 2) {
        reachedReady();
        await readyRelease;
      }
      return transaction(async (c) => {
        await lockActiveOwnerTenant(c, actor);
        return operation(c);
      });
    },
  );
  const buildOutcome = build.then(
    (value) => ({ kind: "settled" as const, ok: true as const, value }),
    (error: unknown) => ({
      kind: "settled" as const,
      ok: false as const,
      error,
    }),
  );
  const confirmation = {
    planId: second.planId,
    expectedAccountId: owner.id,
    expectedTenantId: owner.tenant,
    confirmation: "DELETE" as const,
  };
  let receipt!: AccountDeletionReceipt;
  let completedBuild!:
    Awaited<typeof buildOutcome> | { kind: "timeout"; ok: false };
  let phaseTimeout: NodeJS.Timeout | undefined;
  try {
    const phase = await Promise.race([
      readyReached.then(() => ({ kind: "ready" as const })),
      buildOutcome,
      new Promise<{ kind: "timeout" }>((resolve) => {
        phaseTimeout = setTimeout(() => resolve({ kind: "timeout" }), 15_000);
        phaseTimeout.unref();
      }),
    ]);
    if (phaseTimeout) clearTimeout(phaseTimeout);
    assert.equal(
      phase.kind,
      "ready",
      phase.kind === "settled"
        ? `bundle builder settled before ready: ${phase.ok ? "unexpected success" : String(phase.error)}`
        : "bundle builder did not reach the ready transaction within 15 seconds",
    );
    assert.equal(
      (
        await call(
          "POST",
          "/api/account/deletion",
          confirmation,
          ownerCookie,
          randomBytes(32).toString("base64url"),
        )
      ).statusCode,
      403,
    );
    const confirmed = await call(
      "POST",
      "/api/account/deletion",
      confirmation,
      ownerCookie,
      csrf,
    );
    assert.equal(confirmed.statusCode, 202, confirmed.body);
    receipt = confirmed.json() as AccountDeletionReceipt;
    assert.equal(receipt.requestId, second.planId);
    assert.equal(receipt.state, "access_revoked_pending_purge");
    assert.equal(receipt.purgeAvailable, false);
    assert.equal(receipt.policyVersion, config.ACCOUNT_DELETION_POLICY_VERSION);
    assert.ok(Date.parse(receipt.workingDataPolicyDeadline!) > Date.now());
    assert.ok(
      Date.parse(receipt.backupRetentionPolicyDeadline!) >=
        Date.parse(receipt.requestedAt!),
    );
  } finally {
    if (phaseTimeout) clearTimeout(phaseTimeout);
    releaseReady();
    let completionTimeout: NodeJS.Timeout | undefined;
    completedBuild = await Promise.race([
      buildOutcome,
      new Promise<{ kind: "timeout"; ok: false }>((resolve) => {
        completionTimeout = setTimeout(
          () => resolve({ kind: "timeout", ok: false }),
          15_000,
        );
        completionTimeout.unref();
      }),
    ]);
    if (completionTimeout) clearTimeout(completionTimeout);
  }
  assert.equal(completedBuild.kind, "settled", "bundle build did not settle");
  assert.equal(completedBuild.ok, false);
  if (completedBuild.kind === "settled" && !completedBuild.ok)
    assert.ok(
      completedBuild.error instanceof Problem,
      String(completedBuild.error),
    );
  const derivative = (
    await db.query("SELECT * FROM revision_derivatives WHERE revision_id=$1", [
      bundle.revisionId,
    ])
  ).rows[0];
  assert.equal(derivative.state, "pending");
  assert.equal(derivative.object_key, null);
  assert.equal(derivative.object_version, null);
  assert.ok(new Date(derivative.attempt_expires_at).getTime() <= Date.now());

  const replay = await confirmAccountDeletion(
    actor,
    sessionToken,
    csrf,
    confirmation,
  );
  assert.deepEqual(replay, receipt);
  // The account's usage events and active days went with the request
  // (analytics.ts); the neighbour's stay.
  await flushAnalytics();
  const analyticsRows = async (accountId: string) =>
    Number(
      (
        await db.query(
          `SELECT (SELECT count(*) FROM analytics_events WHERE actor=$1)
                 +(SELECT count(*) FROM analytics_active_days WHERE actor=$1) AS count`,
          [actorKey(accountId)],
        )
      ).rows[0].count,
    );
  assert.equal(await analyticsRows(owner.id), 0);
  assert.ok((await analyticsRows(neighbor.id)) > 0);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM audit_outbox WHERE tenant_id=$1 AND action='account.deletion.requested'",
          [owner.tenant],
        )
      ).rows[0].count,
    ),
    1,
  );

  const enabled = config.ACCOUNT_DELETION_ENABLED;
  (config as any).ACCOUNT_DELETION_ENABLED = false;
  const recovered = await call(
    "POST",
    "/api/account/deletion-status",
    { capability: second.statusCapability },
    "",
  );
  (config as any).ACCOUNT_DELETION_ENABLED = enabled;
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.deepEqual(recovered.json(), receipt);
  assert.equal(
    (
      await call(
        "POST",
        "/api/account/deletion-status",
        { capability: "bad" },
        "",
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await call("POST", "/api/account/deletion-status", {}, "")).statusCode,
    404,
  );

  assert.equal((await call("GET", "/api/me")).statusCode, 401);
  assert.equal(
    (await call("POST", "/api/login", { name: owner.name, password }, ""))
      .statusCode,
    401,
  );
  await assert.rejects(signIn(owner.name, password, "deletion-relogin"), {
    status: 401,
  });
  await assert.rejects(
    recheckServiceActor(cachedServiceActor, "context"),
    (error: unknown) => error instanceof Problem && error.status === 401,
  );
  await assert.rejects(
    authenticateServiceToken(serviceToken, MCP_AUDIENCE),
    (error: unknown) => error instanceof Problem && error.status === 401,
  );
  assert.equal(
    (await call("POST", "/api/resolve", { token: shareToken }, "")).statusCode,
    404,
  );
  assert.equal(
    (await call("GET", "/api/view/bytes", undefined, "", undefined, grant))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await viewer.inject({
        method: "GET",
        url: `/document/${viewerToken}`,
        headers: { host: config.VIEWER_UPSTREAM_HOST, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await call("GET", `/api/revisions/${single.revisionId}/export`, undefined))
      .statusCode,
    401,
  );
  await assert.rejects(
    beginUpload(actor, {
      key: randomUUID(),
      title: "Late write",
      filename: "late.txt",
      mime: "text/plain",
      size: 1,
      sha256: sha256(Buffer.from("x")),
    }),
    (error: unknown) => error instanceof Problem,
  );

  const account = (
    await db.query(
      "SELECT disabled,deletion_requested_at FROM accounts WHERE id=$1",
      [owner.id],
    )
  ).rows[0];
  assert.equal(account.disabled, true);
  assert.ok(account.deletion_requested_at);
  await assert.rejects(
    db.query("UPDATE accounts SET deletion_requested_at=NULL WHERE id=$1", [
      owner.id,
    ]),
  );
  await assert.rejects(
    db.query("UPDATE accounts SET disabled=false WHERE id=$1", [owner.id]),
  );
  assert.equal(
    Number(
      (
        await db.query("SELECT count(*) FROM sessions WHERE account_id=$1", [
          owner.id,
        ])
      ).rows[0].count,
    ),
    0,
  );
  assert.equal(
    (
      await db.query("SELECT revoked_at FROM agent_connections WHERE id=$1", [
        issued.json().connection.id,
      ])
    ).rows[0].revoked_at instanceof Date,
    true,
  );
  assert.equal(
    (await db.query("SELECT revoked FROM shares WHERE id=$1", [share.id]))
      .rows[0].revoked,
    true,
  );
  assert.equal(
    Number(
      (
        await db.query(
          `SELECT count(*) FROM grants issued JOIN shares share ON share.id=issued.share_id
           WHERE share.tenant_id=$1`,
          [owner.tenant],
        )
      ).rows[0].count,
    ),
    0,
  );
  assert.equal(
    (
      await db.query("SELECT aborted FROM uploads WHERE id=$1", [
        pending.json().uploadId,
      ])
    ).rows[0].aborted,
    true,
  );
  const quotaAfter = (
    await db.query(
      "SELECT used_bytes,derivative_used_bytes FROM tenants WHERE id=$1",
      [owner.tenant],
    )
  ).rows[0];
  assert.deepEqual(quotaAfter, quotaBefore);
  assert.deepEqual(
    await readBlob(source.object_key, source.object_version),
    sourceBytesBefore,
  );
  const neighborResolved = await call(
    "POST",
    "/api/resolve",
    { token: neighborShareToken },
    "",
  );
  assert.equal(neighborResolved.statusCode, 200, neighborResolved.body);
  const neighborBytes = await call(
    "GET",
    "/api/view/bytes",
    undefined,
    "",
    undefined,
    neighborResolved.json().grant,
  );
  assert.equal(neighborBytes.statusCode, 200, neighborBytes.body);
  assert.deepEqual(neighborBytes.rawPayload, neighborSingle.bytes);

  const exhaustedIp = "203.0.113.44";
  const unknownCapability = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO login_limits(key,attempts,reset_at) VALUES($1,120,now()+interval '10 minutes')
     ON CONFLICT(key) DO UPDATE SET attempts=120,reset_at=excluded.reset_at`,
    [sha256(`account-deletion-status-ip:${exhaustedIp}`)],
  );
  await assert.rejects(
    accountDeletionStatus(unknownCapability, exhaustedIp),
    (error: unknown) => error instanceof Problem && error.status === 429,
  );
  assert.equal(
    Number(
      (
        await db.query("SELECT count(*) FROM login_limits WHERE key=$1", [
          sha256(`account-deletion-status:${sha256(unknownCapability)}`),
        ])
      ).rows[0].count,
    ),
    0,
  );

  const neighborBegin = await call(
    "POST",
    "/api/uploads",
    {
      key: randomUUID(),
      title: "Neighbor remains active",
      filename: "neighbor.txt",
      mime: "text/plain",
      size: 1,
      sha256: sha256(Buffer.from("n")),
    },
    neighborCookie,
  );
  assert.equal(neighborBegin.statusCode, 200, neighborBegin.body);
  assert.equal(
    (
      await call(
        "DELETE",
        `/api/uploads/${neighborBegin.json().uploadId}`,
        undefined,
        neighborCookie,
      )
    ).statusCode,
    200,
  );

  const marker = await db.connect();
  let markerCommitted = false;
  let racingResolve: ReturnType<typeof call> | undefined;
  try {
    await marker.query("BEGIN");
    await marker.query(
      "SELECT * FROM tenants WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [neighbor.tenant, neighbor.id],
    );
    await marker.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [
      neighbor.id,
    ]);
    await marker.query(
      "UPDATE accounts SET disabled=true,deletion_requested_at=clock_timestamp() WHERE id=$1",
      [neighbor.id],
    );
    // resolve takes the read lock, which still queues behind the marker's
    // FOR UPDATE above; waiting for the write form would never match.
    racingResolve = call(
      "POST",
      "/api/resolve",
      { token: neighborShareToken },
      "",
    );
    let blocked = false;
    for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
      blocked = !!(
        await db.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'
             AND wait_event_type='Lock'
             AND query LIKE '%SELECT kind,owner_id FROM tenants%FOR SHARE%'`,
        )
      ).rowCount;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(blocked, true, "resolve did not reach the tenant lock");
    await marker.query("COMMIT");
    markerCommitted = true;
    const deniedResolve = await racingResolve;
    assert.equal(deniedResolve.statusCode, 404, deniedResolve.body);
  } finally {
    if (!markerCommitted) await marker.query("ROLLBACK").catch(() => undefined);
    marker.release();
    if (racingResolve) await racingResolve.catch(() => undefined);
  }
});
