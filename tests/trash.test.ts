import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { transitionOwnerArtifactLifecycle } from "../apps/server/artifact-trash.ts";
import { buildInlineRevisionWithRunner } from "../apps/server/bundle-derivatives.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
} from "../apps/server/service-auth.ts";
import {
  captureFromAgent,
  statusForAgent,
} from "../apps/server/agent-capture.ts";
import { shareFromAgent } from "../apps/server/shares.ts";
import { readBlob, s3, sha256 } from "../apps/server/storage.ts";
import { prepareCapture } from "../scripts/prepare-capture.ts";

if (!config.HTML_LIVE_ENABLED)
  throw new Error("Run trash.test.ts with HTML_LIVE_ENABLED=true");

const app = await createApp();
const viewer = await createLiveViewerApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;
let ownerCookie = "";
let otherCookie = "";

async function call(
  method: any,
  url: string,
  body?: any,
  cookie = ownerCookie,
  authorization?: string,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      ...(Buffer.isBuffer(body)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    payload: body,
  });
}

async function login(name: string) {
  const response = await call("POST", "/api/login", { name, password }, "");
  assert.equal(response.statusCode, 200, response.body);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

async function saveSingle(source: string, patch: Record<string, unknown> = {}) {
  const bytes = Buffer.from(source);
  const begun = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Trash single",
    filename: "index.html",
    mime: "text/html",
    size: bytes.length,
    sha256: sha256(bytes),
    ...patch,
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const uploadId = begun.json().uploadId as string;
  assert.equal(
    (await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes)).statusCode,
    200,
  );
  const finalized = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(finalized.statusCode, 200, finalized.body);
  return { ...finalized.json(), bytes, uploadId } as any;
}

let preparedBundle: Awaited<ReturnType<typeof prepareCapture>>;
async function saveBundle(patch: Record<string, unknown> = {}) {
  const input = {
    key: randomUUID(),
    title: "Trash bundle",
    manifest: preparedBundle.manifest,
    ...patch,
  };
  const begun = await call("POST", "/api/bundle-uploads", input);
  assert.equal(begun.statusCode, 200, begun.body);
  const uploadId = begun.json().uploadId as string;
  for (const [index, file] of (
    preparedBundle.manifest as any
  ).files.entries()) {
    const supplied = preparedBundle.files.find(
      (item) => item.path === file.path,
    )!;
    const bytes = Buffer.from(supplied.data, supplied.encoding);
    const uploaded = await call(
      "PUT",
      `/api/bundle-uploads/${uploadId}/files/${index}`,
      bytes,
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
  }
  const finalized = await call(
    "POST",
    `/api/bundle-uploads/${uploadId}/finalize`,
    {},
  );
  assert.equal(finalized.statusCode, 200, finalized.body);
  return { ...finalized.json(), uploadId, input } as any;
}

const shareToken = (url: string) => new URL(url).hash.slice(1);
const viewerToken = (url: string) => new URL(url).pathname.split("/").at(-1)!;
const embedded = (token: string) =>
  viewer.inject({
    method: "GET",
    url: `/document/${token}`,
    headers: { host: config.VIEWER_UPSTREAM_HOST, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
  });

let preservedReady: {
  key: string;
  version: string;
  sha256: string;
  size: number;
};

before(async () => {
  preparedBundle = await prepareCapture(
    "tests/fixtures/bundle-corpus/team-report",
    "index.html",
    ["index.html", "assets/report.css", "assets/report.js", "assets/mark.svg"],
  );
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`trash-a-${suffix}`, password);
  other = await createAccount(`trash-b-${suffix}`, password);
  ownerCookie = await login(owner.name);
  otherCookie = await login(other.name);
});

after(async () => {
  await Promise.allSettled([app.close(), viewer.close()]);
  await db.end();
  s3.destroy();
});

test("trash lifecycle is tenant-private, exact-retry idempotent and ABA-safe", async () => {
  const saved = await saveSingle("<!doctype html><p>lifecycle</p>");
  const initial = (
    await call("GET", `/api/artifacts/${saved.artifactId}`)
  ).json();
  assert.equal(initial.trashedAt, null);
  assert.equal(initial.lifecycleVersion, 0);
  const request = {
    expectedLifecycleVersion: 0,
    expectedRevisionId: saved.revisionId,
  };
  assert.equal(
    (
      await call(
        "POST",
        `/api/artifacts/${saved.artifactId}/trash`,
        request,
        otherCookie,
      )
    ).statusCode,
    404,
  );
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [owner.id]);
  await assert.rejects(
    transitionOwnerArtifactLifecycle(
      { id: owner.id, tenant: owner.tenant },
      saved.artifactId,
      request,
      "trashed",
    ),
    (error: any) => error.status === 404,
  );
  await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [owner.id]);

  const trashed = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/trash`,
    request,
  );
  assert.equal(trashed.statusCode, 200, trashed.body);
  assert.equal(trashed.json().lifecycleVersion, 1);
  assert.ok(trashed.json().trashedAt);
  const retried = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/trash`,
    request,
  );
  assert.deepEqual(retried.json(), trashed.json());
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM audit_outbox WHERE action='artifact.trashed' AND target_id=$1",
          [saved.artifactId],
        )
      ).rows[0].count,
    ),
    1,
  );
  assert.equal(
    (
      await call("POST", `/api/artifacts/${saved.artifactId}/restore`, {
        ...request,
        expectedLifecycleVersion: 0,
      })
    ).statusCode,
    409,
  );
  const restored = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/restore`,
    { ...request, expectedLifecycleVersion: 1 },
  );
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json(), {
    id: saved.artifactId,
    trashedAt: null,
    lifecycleVersion: 2,
  });
  assert.deepEqual(
    (
      await call("POST", `/api/artifacts/${saved.artifactId}/restore`, {
        ...request,
        expectedLifecycleVersion: 1,
      })
    ).json(),
    restored.json(),
  );
  assert.equal(
    (await call("POST", `/api/artifacts/${saved.artifactId}/trash`, request))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await call("POST", `/api/artifacts/${saved.artifactId}/trash`, {
        ...request,
        expectedLifecycleVersion: 2,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call("POST", `/api/artifacts/${saved.artifactId}/restore`, {
        ...request,
        expectedLifecycleVersion: 1,
      })
    ).statusCode,
    409,
  );
});

test("trash preserves immutable sources and ready derivative while closing every old capability", async () => {
  const singleV1 = await saveSingle("<!doctype html><p>single one</p>");
  const singleV2 = await saveSingle("<!doctype html><p>single two</p>", {
    artifactId: singleV1.artifactId,
    baseRevisionId: singleV1.revisionId,
  });
  const bundleV1 = await saveBundle();
  const bundleV2 = await saveBundle({
    artifactId: bundleV1.artifactId,
    baseRevisionId: bundleV1.revisionId,
  });
  const built = await call(
    "POST",
    `/api/revisions/${bundleV2.revisionId}/build-inline`,
    {},
  );
  assert.equal(built.statusCode, 200, built.body);
  assert.equal(built.json().state, "ready");
  const derivative = (
    await db.query(
      "SELECT * FROM revision_derivatives WHERE revision_id=$1 AND state='ready'",
      [bundleV2.revisionId],
    )
  ).rows[0];
  preservedReady = {
    key: derivative.object_key,
    version: derivative.object_version,
    sha256: derivative.sha256,
    size: Number(derivative.size),
  };
  const quotaBefore = (
    await db.query(
      "SELECT used_bytes,derivative_used_bytes FROM tenants WHERE id=$1",
      [owner.tenant],
    )
  ).rows[0];
  const revisionRowsBefore = (
    await db.query(
      `SELECT id,sha256,object_key,object_version,manifest_sha256
       FROM revisions WHERE artifact_id=ANY($1::uuid[]) ORDER BY id`,
      [[singleV1.artifactId, bundleV1.artifactId]],
    )
  ).rows;
  const bundleExports = new Map<string, unknown>();
  for (const revisionId of [bundleV1.revisionId, bundleV2.revisionId]) {
    const response = await call("GET", `/api/revisions/${revisionId}/export`);
    assert.equal(response.statusCode, 200, response.body);
    bundleExports.set(revisionId, response.json());
  }
  const shared = await call(
    "POST",
    `/api/artifacts/${bundleV1.artifactId}/share`,
    { expectedRevisionId: bundleV2.revisionId, expiresInDays: 1 },
  );
  assert.equal(shared.statusCode, 200, shared.body);
  const oldShare = shared.json().share;
  const token = shareToken(oldShare.url);
  const shareConnection = randomUUID();
  const shareAgentToken = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(
       id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at
     ) VALUES($1,$2,$3,$4,'trash-share-agent',ARRAY['share'],$5,now()+interval '1 day')`,
    [
      shareConnection,
      owner.tenant,
      owner.id,
      sha256(shareAgentToken),
      MCP_AUDIENCE,
    ],
  );
  const shareActor = await authenticateServiceToken(
    shareAgentToken,
    MCP_AUDIENCE,
    "share",
  );
  const agentShareInput = {
    key: randomUUID(),
    artifactId: bundleV1.artifactId,
    expectedRevisionId: bundleV2.revisionId,
    expiresInDays: 1 as const,
  };
  const agentShare = await shareFromAgent(shareActor, agentShareInput);
  assert.equal(agentShare.state, "active");
  assert.equal(agentShare.shareId, oldShare.id);
  const resolved = await call("POST", "/api/resolve", { token }, "");
  assert.equal(resolved.statusCode, 200, resolved.body);
  const sourceGrant = resolved.json().grant;
  const recipientLive = await call(
    "POST",
    "/api/view/live-view",
    {},
    "",
    sourceGrant,
  );
  const ownerLive = await call(
    "POST",
    `/api/revisions/${bundleV2.revisionId}/live-view`,
    {},
  );
  assert.equal(recipientLive.statusCode, 200, recipientLive.body);
  assert.equal(ownerLive.statusCode, 200, ownerLive.body);
  const recipientViewerToken = viewerToken(recipientLive.json().url);
  const ownerViewerToken = viewerToken(ownerLive.json().url);
  assert.equal((await embedded(recipientViewerToken)).statusCode, 200);
  assert.equal((await embedded(ownerViewerToken)).statusCode, 200);

  for (const saved of [singleV2, bundleV2]) {
    const response = await call(
      "POST",
      `/api/artifacts/${saved.artifactId}/trash`,
      {
        expectedLifecycleVersion: 0,
        expectedRevisionId: saved.revisionId,
      },
    );
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal(
    (await call("GET", `/api/revisions/${singleV1.revisionId}/bytes`)).body,
    singleV1.bytes.toString(),
  );
  assert.equal(
    (await call("GET", `/api/revisions/${singleV2.revisionId}/bytes`)).body,
    singleV2.bytes.toString(),
  );
  for (const [revisionId, expected] of bundleExports) {
    const response = await call("GET", `/api/revisions/${revisionId}/export`);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), expected);
  }
  assert.equal(
    (await call("GET", `/api/revisions/${singleV2.revisionId}/document`))
      .statusCode,
    404,
  );
  assert.equal(
    (await call("POST", "/api/resolve", { token }, "")).statusCode,
    404,
  );
  assert.equal(
    (await call("GET", "/api/view/bytes", undefined, "", sourceGrant))
      .statusCode,
    404,
  );
  assert.equal(
    (await call("POST", `/api/revisions/${bundleV2.revisionId}/live-view`, {}))
      .statusCode,
    404,
  );
  assert.equal(
    (await call("POST", "/api/view/live-view", {}, "", sourceGrant)).statusCode,
    404,
  );
  assert.equal((await embedded(recipientViewerToken)).statusCode, 404);
  assert.equal((await embedded(ownerViewerToken)).statusCode, 404);

  for (const saved of [singleV2, bundleV2]) {
    const response = await call(
      "POST",
      `/api/artifacts/${saved.artifactId}/restore`,
      {
        expectedLifecycleVersion: 1,
        expectedRevisionId: saved.revisionId,
      },
    );
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal(
    (await call("POST", "/api/resolve", { token }, "")).statusCode,
    404,
  );
  assert.equal((await embedded(recipientViewerToken)).statusCode, 404);
  assert.deepEqual(await shareFromAgent(shareActor, agentShareInput), {
    shareId: oldShare.id,
    artifactId: bundleV1.artifactId,
    revisionId: bundleV2.revisionId,
    derivativeId: derivative.id,
    expiresAt: agentShare.expiresAt,
    state: "closed",
    url: null,
  });
  const fresh = await call(
    "POST",
    `/api/artifacts/${bundleV1.artifactId}/share`,
    { expectedRevisionId: bundleV2.revisionId, expiresInDays: 1 },
  );
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.notEqual(fresh.json().share.id, oldShare.id);
  assert.equal(
    (
      await call(
        "POST",
        "/api/resolve",
        { token: shareToken(fresh.json().share.url) },
        "",
      )
    ).statusCode,
    200,
  );
  assert.deepEqual(
    (
      await db.query(
        `SELECT id,sha256,object_key,object_version,manifest_sha256
         FROM revisions WHERE artifact_id=ANY($1::uuid[]) ORDER BY id`,
        [[singleV1.artifactId, bundleV1.artifactId]],
      )
    ).rows,
    revisionRowsBefore,
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT used_bytes,derivative_used_bytes FROM tenants WHERE id=$1",
        [owner.tenant],
      )
    ).rows[0],
    quotaBefore,
  );
  const stillReady = (
    await db.query("SELECT * FROM revision_derivatives WHERE id=$1", [
      derivative.id,
    ])
  ).rows[0];
  assert.equal(stillReady.state, "ready");
  assert.equal(stillReady.object_version, derivative.object_version);
});

test("trash aborts pending revisions but keeps committed agent receipt closed and recoverable", async () => {
  const base = await saveSingle("<!doctype html><p>pending base</p>");
  const nextBytes = Buffer.from("<!doctype html><p>pending next</p>");
  const singleStart = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Pending single",
    filename: "index.html",
    mime: "text/html",
    size: nextBytes.length,
    sha256: sha256(nextBytes),
    artifactId: base.artifactId,
    baseRevisionId: base.revisionId,
  });
  assert.equal(singleStart.statusCode, 200, singleStart.body);
  const singleUpload = singleStart.json().uploadId as string;
  assert.equal(
    (await call("PUT", `/api/uploads/${singleUpload}/bytes`, nextBytes))
      .statusCode,
    200,
  );
  const bundleStart = await call("POST", "/api/bundle-uploads", {
    key: randomUUID(),
    title: "Pending bundle",
    manifest: preparedBundle.manifest,
    artifactId: base.artifactId,
    baseRevisionId: base.revisionId,
  });
  assert.equal(bundleStart.statusCode, 200, bundleStart.body);
  const bundleUpload = bundleStart.json().uploadId as string;
  const firstFile = (preparedBundle.manifest as any).files[0];
  const supplied = preparedBundle.files.find(
    (item) => item.path === firstFile.path,
  )!;
  assert.equal(
    (
      await call(
        "PUT",
        `/api/bundle-uploads/${bundleUpload}/files/0`,
        Buffer.from(supplied.data, supplied.encoding),
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call("POST", `/api/artifacts/${base.artifactId}/trash`, {
        expectedLifecycleVersion: 0,
        expectedRevisionId: base.revisionId,
      })
    ).statusCode,
    200,
  );
  for (const [path, method, body] of [
    [`/api/uploads/${singleUpload}/bytes`, "PUT", nextBytes],
    [`/api/uploads/${singleUpload}/finalize`, "POST", {}],
    [
      `/api/bundle-uploads/${bundleUpload}/files/0`,
      "PUT",
      Buffer.from(supplied.data, supplied.encoding),
    ],
    [`/api/bundle-uploads/${bundleUpload}/finalize`, "POST", {}],
  ] as const)
    assert.equal((await call(method, path, body)).statusCode, 410, path);
  assert.equal(
    (
      await call("POST", `/api/artifacts/${base.artifactId}/restore`, {
        expectedLifecycleVersion: 1,
        expectedRevisionId: base.revisionId,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await call("POST", `/api/uploads/${singleUpload}/finalize`, {}))
      .statusCode,
    410,
  );

  const connectionId = randomUUID();
  const rawToken = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(
       id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at
     ) VALUES($1,$2,$3,$4,'trash-agent',ARRAY['context','capture','revise'],$5,now()+interval '1 day')`,
    [connectionId, owner.tenant, owner.id, sha256(rawToken), MCP_AUDIENCE],
  );
  const actor = await authenticateServiceToken(
    rawToken,
    MCP_AUDIENCE,
    "capture",
  );
  const captureInput = {
    ...preparedBundle,
    key: randomUUID(),
    title: "Committed agent bundle",
  };
  const receipt = await captureFromAgent(actor, captureInput, "capture");
  assert.equal(
    (await statusForAgent(actor, { key: captureInput.key })).artifactState,
    "active",
  );
  assert.equal(
    (
      await call("POST", `/api/artifacts/${receipt.artifactId}/trash`, {
        expectedLifecycleVersion: 0,
        expectedRevisionId: receipt.revisionId,
      })
    ).statusCode,
    200,
  );
  const closedStatus = await statusForAgent(actor, { key: captureInput.key });
  assert.equal(closedStatus.state, "saved");
  assert.equal(closedStatus.artifactState, "trashed");
  assert.equal(closedStatus.preview, null);
  assert.deepEqual(
    await captureFromAgent(actor, captureInput, "capture"),
    receipt,
  );
  const fresh = await captureFromAgent(
    actor,
    { ...captureInput, key: randomUUID(), title: "Fresh agent bundle" },
    "capture",
  );
  assert.notEqual(fresh.artifactId, receipt.artifactId);
});

test("grant issuance serialized behind trash cannot create a capability after restore", async () => {
  const saved = await saveSingle("<!doctype html><p>grant barrier</p>");
  const shared = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/share`,
    { expectedRevisionId: saved.revisionId, expiresInDays: 1 },
  );
  assert.equal(shared.statusCode, 200, shared.body);
  const token = shareToken(shared.json().share.url);
  const blocker = await db.connect();
  const waitForBlocked = async (fragment: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const blocked = await db.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE pid<>pg_backend_pid() AND datname=current_database()
           AND wait_event_type='Lock' AND query LIKE $1 LIMIT 1`,
        [`%${fragment}%`],
      );
      if (blocked.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected blocked query containing ${fragment}`);
  };
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM artifacts WHERE id=$1 FOR UPDATE", [
      saved.artifactId,
    ]);
    const trashing = call("POST", `/api/artifacts/${saved.artifactId}/trash`, {
      expectedLifecycleVersion: 0,
      expectedRevisionId: saved.revisionId,
    });
    await waitForBlocked("FROM artifacts%WHERE id=$1%FOR UPDATE");
    const resolving = call("POST", "/api/resolve", { token }, "");
    await waitForBlocked("FROM tenants WHERE id=$1 FOR UPDATE");
    await blocker.query("COMMIT");
    assert.equal((await trashing).statusCode, 200);
    assert.equal((await resolving).statusCode, 404);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  assert.equal(
    (
      await call("POST", `/api/artifacts/${saved.artifactId}/restore`, {
        expectedLifecycleVersion: 1,
        expectedRevisionId: saved.revisionId,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await call("POST", "/api/resolve", { token }, "")).statusCode,
    404,
  );
  assert.equal(
    Number(
      (
        await db.query(
          `SELECT count(*) FROM grants issued_grant
           JOIN shares share ON share.id=issued_grant.share_id
           WHERE share.artifact_id=$1`,
          [saved.artifactId],
        )
      ).rows[0].count,
    ),
    0,
  );
});

test("a worker admitted before trash cannot publish after trash and restore", async () => {
  const saved = await saveBundle();
  const quotaBefore = Number(
    (
      await db.query("SELECT derivative_used_bytes FROM tenants WHERE id=$1", [
        owner.tenant,
      ])
    ).rows[0].derivative_used_bytes,
  );
  let calls = 0;
  let releaseReady!: () => void;
  let announceReady!: () => void;
  const readyPhase = new Promise<void>((resolve) => (announceReady = resolve));
  const release = new Promise<void>((resolve) => (releaseReady = resolve));
  const runner = async <T>(operation: (c: any) => Promise<T>) => {
    calls++;
    if (calls === 2) {
      announceReady();
      await release;
    }
    return transaction(async (c) => {
      const locked = await c.query(
        `SELECT 1 FROM tenants tenant JOIN accounts account ON account.id=tenant.owner_id
         WHERE tenant.id=$1 AND tenant.owner_id=$2 AND NOT account.disabled
         FOR UPDATE OF tenant`,
        [owner.tenant, owner.id],
      );
      assert.equal(locked.rowCount, 1);
      return operation(c);
    });
  };
  const building = buildInlineRevisionWithRunner(
    { id: owner.id, tenant: owner.tenant },
    saved.revisionId,
    runner,
  );
  await readyPhase;
  const trashed = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/trash`,
    { expectedLifecycleVersion: 0, expectedRevisionId: saved.revisionId },
  );
  assert.equal(trashed.statusCode, 200, trashed.body);
  const restored = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/restore`,
    { expectedLifecycleVersion: 1, expectedRevisionId: saved.revisionId },
  );
  assert.equal(restored.statusCode, 200, restored.body);
  releaseReady();
  const outcome = await building;
  assert.equal(outcome.status.state, "pending");
  const pending = (
    await db.query("SELECT * FROM revision_derivatives WHERE revision_id=$1", [
      saved.revisionId,
    ])
  ).rows[0];
  assert.equal(pending.state, "pending");
  assert.ok(new Date(pending.attempt_expires_at).getTime() <= Date.now());
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT derivative_used_bytes FROM tenants WHERE id=$1",
          [owner.tenant],
        )
      ).rows[0].derivative_used_bytes,
    ),
    quotaBefore,
  );

  const cleanup = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/maintenance.ts"],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(
    (
      await db.query("SELECT state FROM revision_derivatives WHERE id=$1", [
        pending.id,
      ])
    ).rows[0].state,
    "failed",
  );
  const readyBytes = await readBlob(preservedReady.key, preservedReady.version);
  assert.equal(readyBytes.length, preservedReady.size);
  assert.equal(sha256(readyBytes), preservedReady.sha256);
});

test("active shelf excludes trash and trash cursor preserves microseconds", async () => {
  const ids: string[] = [];
  for (let index = 0; index < 26; index++) {
    const saved = await saveSingle(`<!doctype html><p>page ${index}</p>`, {
      title: `Trash page ${String(index).padStart(2, "0")}`,
    });
    ids.push(saved.artifactId);
    assert.equal(
      (
        await call("POST", `/api/artifacts/${saved.artifactId}/trash`, {
          expectedLifecycleVersion: 0,
          expectedRevisionId: saved.revisionId,
        })
      ).statusCode,
      200,
    );
  }
  await transaction(async (c) => {
    for (const [index, id] of ids.entries())
      await c.query(
        `UPDATE artifacts
         SET trashed_at=('2026-09-21T12:00:00.000000Z'::timestamptz
                         + $2*interval '1 microsecond')
         WHERE id=$1`,
        [id, index + 100],
      );
  });
  const first = await call("GET", "/api/trash");
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().items.length, 24);
  assert.ok(first.json().nextCursor);
  const second = await call(
    "GET",
    `/api/trash?cursor=${encodeURIComponent(first.json().nextCursor)}`,
  );
  assert.equal(second.statusCode, 200, second.body);
  const paged = [...first.json().items, ...second.json().items]
    .map((artifact: any) => artifact.id)
    .filter((id: string) => ids.includes(id));
  assert.equal(new Set(paged).size, 26);
  assert.equal(paged.length, 26);
  const shelf = await call("GET", "/api/artifacts?q=Trash%20page");
  assert.equal(shelf.statusCode, 200, shelf.body);
  assert.equal(shelf.json().items.length, 0);
  assert.equal((await call("GET", "/api/trash?cursor=bad")).statusCode, 400);
});
