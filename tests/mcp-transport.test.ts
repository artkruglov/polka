import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { prepareCapture } from "../scripts/prepare-capture.ts";

if (MCP_AUDIENCE !== `${config.APP_ORIGIN}/mcp`)
  throw new Error("MCP audience must be the actual mounted endpoint");

const app = await createApp();
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";
let csrf = "";
let bearer = "";
let connectionId = "";

async function web(path: string, init: RequestInit = {}, includeOrigin = true) {
  return fetch(`${config.APP_ORIGIN}${path}`, {
    ...init,
    headers: {
      ...(includeOrigin ? { origin: config.APP_ORIGIN } : {}),
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function issue(scopes: string[]) {
  const response = await web("/api/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json", "x-polka-csrf": csrf },
    body: JSON.stringify({
      name: `MCP test ${scopes.join("-")}`,
      scopes,
      audience: MCP_AUDIENCE,
    }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
}

async function saveHtml(
  source: string,
  title: string,
  prior?: { artifactId: string; revisionId: string },
) {
  const bytes = Buffer.from(source);
  const begun = await web("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: randomUUID(),
      title,
      filename: "index.html",
      mime: "text/html",
      size: bytes.length,
      sha256: sha256(bytes),
      ...(prior
        ? {
            artifactId: prior.artifactId,
            baseRevisionId: prior.revisionId,
          }
        : {}),
    }),
  });
  assert.equal(begun.status, 200);
  const uploadId = ((await begun.json()) as any).uploadId;
  assert.equal(
    (
      await web(`/api/uploads/${uploadId}/bytes`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      })
    ).status,
    200,
  );
  const finalized = await web(`/api/uploads/${uploadId}/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(finalized.status, 200);
  return finalized.json() as Promise<any>;
}

async function mcpClient(token: string, observedHeaders?: Headers[]) {
  const client = new Client(
    { name: "polka-integration", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_AUDIENCE), {
    authProvider: { token: async () => token },
    onInsufficientScope: "throw",
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      observedHeaders?.push(new Headers(response.headers));
      return response;
    },
  });
  await client.connect(transport);
  return client;
}

before(async () => {
  await app.listen({ host: config.HOST, port: config.PORT });
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`mcp-a-${suffix}`, password);
  other = await createAccount(`mcp-b-${suffix}`, password);
  const login = await web(
    "/api/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: owner.name, password }),
    },
    true,
  );
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
  const csrfResponse = await web("/api/agent-connections/csrf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(csrfResponse.status, 200);
  csrf = ((await csrfResponse.json()) as any).csrfToken;
  const issued = await issue(["context", "read"]);
  bearer = issued.token;
  connectionId = issued.connection.id;

  await transaction(async (c) => {
    for (const [account, tenant, title, updated] of [
      [owner.id, owner.tenant, "Owner newest", "2026-09-20T12:00:02Z"],
      [owner.id, owner.tenant, "Owner older", "2026-09-20T12:00:01Z"],
      [
        owner.id,
        owner.tenant,
        "Precision newer",
        "2026-09-20T12:00:00.123200Z",
      ],
      [
        owner.id,
        owner.tenant,
        "Precision older",
        "2026-09-20T12:00:00.123100Z",
      ],
      [other.id, other.tenant, "Foreign secret", "2026-09-20T12:00:03Z"],
    ] as const) {
      const artifact = randomUUID();
      const revision = randomUUID();
      await c.query(
        "INSERT INTO artifacts(id,tenant_id,created_by,title,updated_at) VALUES($1,$2,$3,$4,$5)",
        [artifact, tenant, account, title, updated],
      );
      await c.query(
        `INSERT INTO revisions(
           id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,
           object_key,object_version,storage_kind,total_size
         ) VALUES($1,$2,$3,1,$4,'note.txt','text/plain',4,$5,$6,'test-version','single',4)`,
        [
          revision,
          tenant,
          artifact,
          account,
          sha256("note"),
          `${tenant}/mcp-test/${revision}`,
        ],
      );
      await c.query("UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1", [
        artifact,
        revision,
      ]);
      if (title === "Owner newest")
        await c.query(
          `INSERT INTO shares(id,tenant_id,artifact_id,revision_id,token_hash,expires_at)
           VALUES($1,$2,$3,$4,$5,now()+interval '1 day')`,
          [randomUUID(), tenant, artifact, revision, sha256(randomBytes(32))],
        );
    }
  });
});

after(async () => {
  bearer = "";
  csrf = "";
  await app.close();
  await db.end();
  s3.destroy();
});

test("official client negotiates HTTP and reads honest context, resources, and tenant metadata", async () => {
  const observedHeaders: Headers[] = [];
  const client = await mcpClient(bearer, observedHeaders);
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "polka_context",
    "polka_get_artifact",
    "polka_list",
    "polka_list_folders",
    "polka_status",
  ]);
  const context = await client.callTool({
    name: "polka_context",
    arguments: {},
  });
  const contextValue = context.structuredContent as any;
  assert.equal(contextValue.apiVersion, "mcp-capture-v1");
  assert.equal(contextValue.capabilities.readOnly, true);
  assert.equal(contextValue.capabilities.capture, false);
  assert.equal(contextValue.capabilities.revise, false);
  assert.equal(contextValue.capabilities.share, false);
  assert.equal(contextValue.capabilities.manage, false);
  assert.equal(contextValue.capabilities.status, true);
  assert.equal(contextValue.capabilities.preview.automatic, false);
  assert.equal(contextValue.capabilities.preview.buildViaMcp, false);

  const resources = await client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [
    "polka://guides/capture-v1",
    "polka://guides/html-inline-v1",
    "polka://guides/sharing-v1",
  ]);
  const guide = await client.readResource({ uri: "polka://guides/capture-v1" });
  assert.match((guide.contents[0] as any).text, /prepare-capture\.ts/);
  assert.match((guide.contents[0] as any).text, /explicit tool call uploads/);
  assert.match(
    (guide.contents[0] as any).text,
    /Preparation alone is not a save/,
  );

  const first = await client.callTool({
    name: "polka_list",
    arguments: { limit: 1 },
  });
  const firstPage = first.structuredContent as any;
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].title, "Owner newest");
  assert.ok(firstPage.nextCursor);
  const serialized = JSON.stringify(firstPage);
  for (const absent of [
    "Foreign secret",
    "share",
    "grant",
    "token_hash",
    "object_key",
    "data",
  ])
    assert.equal(serialized.includes(absent), false, absent);
  const second = await client.callTool({
    name: "polka_list",
    arguments: { limit: 1, cursor: firstPage.nextCursor },
  });
  const secondPage = second.structuredContent as any;
  assert.equal(secondPage.items[0].title, "Owner older");

  const precisionFirst = (
    await client.callTool({
      name: "polka_list",
      arguments: { query: "Precision", limit: 1 },
    })
  ).structuredContent as any;
  assert.equal(precisionFirst.items[0].title, "Precision newer");
  const precisionSecond = (
    await client.callTool({
      name: "polka_list",
      arguments: {
        query: "Precision",
        limit: 1,
        cursor: precisionFirst.nextCursor,
      },
    })
  ).structuredContent as any;
  assert.equal(precisionSecond.items[0].title, "Precision older");
  assert.equal(precisionSecond.nextCursor, null);
  const hiddenArtifact = (
    await db.query(
      `SELECT artifact.id,artifact.latest_revision_id,artifact.lifecycle_version
       FROM artifacts artifact
       WHERE artifact.tenant_id=$1 AND artifact.title='Owner older'`,
      [owner.tenant],
    )
  ).rows[0];
  const trashed = await web(`/api/artifacts/${hiddenArtifact.id}/trash`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedLifecycleVersion: hiddenArtifact.lifecycle_version,
      expectedRevisionId: hiddenArtifact.latest_revision_id,
    }),
  });
  assert.equal(trashed.status, 200);
  const hiddenList = (
    await client.callTool({
      name: "polka_list",
      arguments: { query: "Owner older" },
    })
  ).structuredContent as any;
  assert.deepEqual(hiddenList.items, []);
  const restored = await web(`/api/artifacts/${hiddenArtifact.id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedLifecycleVersion: hiddenArtifact.lifecycle_version + 1,
      expectedRevisionId: hiddenArtifact.latest_revision_id,
    }),
  });
  assert.equal(restored.status, 200);
  assert.ok(observedHeaders.length > 0);
  for (const headers of observedHeaders) {
    assert.equal(headers.get("cache-control"), "no-store");
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("referrer-policy"), "no-referrer");
    assert.equal(headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  }
  await client.close();
});

test("official client discovers and performs scoped management without web mutation", async () => {
  const saved = await saveHtml(
    "<!doctype html><title>managed</title><p>source</p>",
    "Managed through MCP",
  );
  const folderId = randomUUID();
  await db.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$2,$3)", [
    folderId,
    owner.tenant,
    `MCP destination ${randomUUID()}`,
  ]);
  const issued = await issue(["context", "read", "manage"]);
  const client = await mcpClient(issued.token);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    [
      "polka_context",
      "polka_get_artifact",
      "polka_list",
      "polka_list_folders",
      "polka_restore",
      "polka_status",
      "polka_trash",
      "polka_update_artifact",
    ],
  );
  const context = (
    await client.callTool({ name: "polka_context", arguments: {} })
  ).structuredContent as any;
  assert.equal(context.capabilities.manage, true);
  assert.equal(context.capabilities.readOnly, false);
  const resources = await client.listResources();
  assert.ok(
    resources.resources.some(
      (resource) => resource.uri === "polka://guides/management-v1",
    ),
  );

  const before = (
    await client.callTool({
      name: "polka_get_artifact",
      arguments: { artifactId: saved.artifactId },
    })
  ).structuredContent as any;
  assert.equal(before.title, "Managed through MCP");
  assert.equal(JSON.stringify(before).includes("share"), false);
  const metadataInput = {
    key: randomUUID(),
    artifactId: saved.artifactId,
    title: "Managed result",
    folderId,
    expectedTitle: before.title,
    expectedFolderId: before.folderId,
  };
  const updated = (
    await client.callTool({
      name: "polka_update_artifact",
      arguments: metadataInput,
    })
  ).structuredContent as any;
  assert.equal(updated.replayed, false);
  assert.equal(updated.applied.title, "Managed result");
  const replayed = (
    await client.callTool({
      name: "polka_update_artifact",
      arguments: metadataInput,
    })
  ).structuredContent as any;
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.applied, updated.applied);

  const trashed = (
    await client.callTool({
      name: "polka_trash",
      arguments: {
        artifactId: saved.artifactId,
        expectedLifecycleVersion: before.lifecycleVersion,
        expectedRevisionId: saved.revisionId,
      },
    })
  ).structuredContent as any;
  assert.equal(trashed.lifecycleVersion, before.lifecycleVersion + 1);
  const trashList = (
    await client.callTool({
      name: "polka_list",
      arguments: { state: "trashed", query: "Managed result" },
    })
  ).structuredContent as any;
  assert.deepEqual(
    trashList.items.map((item: any) => item.id),
    [saved.artifactId],
  );
  const restored = (
    await client.callTool({
      name: "polka_restore",
      arguments: {
        artifactId: saved.artifactId,
        expectedLifecycleVersion: trashed.lifecycleVersion,
        expectedRevisionId: saved.revisionId,
      },
    })
  ).structuredContent as any;
  assert.equal(restored.lifecycleVersion, trashed.lifecycleVersion + 1);

  const manageOnlyIssued = await issue(["manage"]);
  const manageOnly = await mcpClient(manageOnlyIssued.token);
  assert.deepEqual(
    (await manageOnly.listTools()).tools.map((tool) => tool.name).sort(),
    ["polka_restore", "polka_trash", "polka_update_artifact"],
  );
  await manageOnly.close();

  const revoked = await web(
    `/api/agent-connections/${issued.connection.id}/revoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-polka-csrf": csrf },
      body: "{}",
    },
  );
  assert.equal(revoked.status, 200);
  await assert.rejects(
    client.callTool({
      name: "polka_update_artifact",
      arguments: metadataInput,
    }),
    (error: any) => error?.name === "UnauthorizedError",
  );
  await client.close();
});

test("official client captures, prepares, shares, revises, isolates connections, and observes revoke", async () => {
  const issued = await issue(["context", "capture", "revise", "share"]);
  const client = await mcpClient(issued.token);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    [
      "polka_capture",
      "polka_context",
      "polka_prepare_preview",
      "polka_revise",
      "polka_revoke_share",
      "polka_share",
      "polka_status",
    ],
  );
  const context = (
    await client.callTool({ name: "polka_context", arguments: {} })
  ).structuredContent as any;
  assert.equal(context.apiVersion, "mcp-capture-v1");
  assert.equal(context.capabilities.readOnly, false);
  assert.equal(context.capabilities.capture, true);
  assert.equal(context.capabilities.revise, true);
  assert.equal(context.capabilities.share, true);
  assert.equal(context.capabilities.preview.buildViaMcp, true);

  const prepared = await prepareCapture(
    "tests/fixtures/bundle-corpus/team-report",
    "index.html",
    ["index.html", "assets/report.css", "assets/report.js", "assets/mark.svg"],
  );
  const captureInput = {
    ...prepared,
    key: randomUUID(),
    title: "MCP transport capture",
  };
  const first = await client.callTool({
    name: "polka_capture",
    arguments: captureInput,
  });
  assert.equal(first.isError, undefined);
  const receipt = first.structuredContent as any;
  assert.equal(receipt.storageKind, "bundle");
  assert.equal(receipt.number, 1);
  for (const absent of ["files", "data", "objectKey", "shareUrl"])
    assert.equal(JSON.stringify(receipt).includes(absent), false, absent);
  assert.deepEqual(
    (
      await client.callTool({
        name: "polka_capture",
        arguments: captureInput,
      })
    ).structuredContent,
    receipt,
  );
  const exportBefore = await web(`/api/revisions/${receipt.revisionId}/export`);
  assert.equal(exportBefore.status, 200);
  const original = await exportBefore.json();
  const statusBefore = (
    await client.callTool({
      name: "polka_status",
      arguments: { key: captureInput.key },
    })
  ).structuredContent as any;
  assert.equal(statusBefore.state, "saved");
  assert.equal(statusBefore.preview, null);
  const derivativeBytesBefore = Number(
    (
      await db.query("SELECT derivative_used_bytes FROM tenants WHERE id=$1", [
        owner.tenant,
      ])
    ).rows[0].derivative_used_bytes,
  );
  const preview = (
    await client.callTool({
      name: "polka_prepare_preview",
      arguments: { key: captureInput.key },
    })
  ).structuredContent as any;
  assert.equal(preview.state, "ready");
  assert.equal(preview.revisionId, receipt.revisionId);
  assert.equal(preview.uploadId, receipt.uploadId);
  assert.equal(preview.concurrent, false);
  const derivativeBytesReady = Number(
    (
      await db.query("SELECT derivative_used_bytes FROM tenants WHERE id=$1", [
        owner.tenant,
      ])
    ).rows[0].derivative_used_bytes,
  );
  assert.ok(derivativeBytesReady > derivativeBytesBefore);
  const retriedPreview = (
    await client.callTool({
      name: "polka_prepare_preview",
      arguments: { uploadId: receipt.uploadId },
    })
  ).structuredContent as any;
  assert.equal(retriedPreview.state, "ready");
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT derivative_used_bytes FROM tenants WHERE id=$1",
          [owner.tenant],
        )
      ).rows[0].derivative_used_bytes,
    ),
    derivativeBytesReady,
  );
  const statusReady = (
    await client.callTool({
      name: "polka_status",
      arguments: { uploadId: receipt.uploadId },
    })
  ).structuredContent as any;
  assert.equal(statusReady.preview.state, "ready");
  const exportAfter = await web(`/api/revisions/${receipt.revisionId}/export`);
  assert.equal(exportAfter.status, 200);
  assert.deepEqual(await exportAfter.json(), original);
  const shared = (
    await client.callTool({
      name: "polka_share",
      arguments: {
        key: randomUUID(),
        artifactId: receipt.artifactId,
        expectedRevisionId: receipt.revisionId,
        expiresInDays: 1,
      },
    })
  ).structuredContent as any;
  assert.equal(shared.state, "active");
  assert.ok(shared.url);
  assert.deepEqual(
    (
      await client.callTool({
        name: "polka_revoke_share",
        arguments: { shareId: shared.shareId },
      })
    ).structuredContent,
    { ok: true },
  );
  const largeBytes = Buffer.concat([
    Buffer.from("<!doctype html><meta charset=utf-8><pre>"),
    Buffer.alloc(4 * 1024 * 1024, "x"),
    Buffer.from("</pre>"),
  ]);
  const largeInput = {
    key: randomUUID(),
    title: "MCP body-limit proof",
    manifest: {
      version: 1,
      entrypoint: "index.html",
      runtime: "preserved-only-v1",
      files: [
        {
          path: "index.html",
          mime: "text/html",
          size: largeBytes.length,
          sha256: sha256(largeBytes),
        },
      ],
      provenance: {
        kind: "mcp",
        sourceUrl: null,
        capturedAt: new Date().toISOString(),
        attribution: "MCP integration test",
        license: "unknown",
      },
      dependencies: { status: "unknown", unresolved: [] },
    },
    files: [
      {
        path: "index.html",
        encoding: "base64",
        data: largeBytes.toString("base64"),
      },
    ],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(largeInput)) > 5 * 1024 * 1024);
  const largeReceipt = (
    await client.callTool({
      name: "polka_capture",
      arguments: largeInput,
    })
  ).structuredContent as any;
  assert.equal(largeReceipt.storageKind, "bundle");
  const status = (
    await client.callTool({
      name: "polka_status",
      arguments: { key: captureInput.key },
    })
  ).structuredContent as any;
  assert.equal(status.state, "saved");
  assert.deepEqual(status.receipt, receipt);

  const otherIssued = await issue(["context"]);
  const otherClient = await mcpClient(otherIssued.token);
  assert.deepEqual(
    (await otherClient.listTools()).tools.map((tool) => tool.name).sort(),
    ["polka_context", "polka_status"],
  );
  const hiddenStatus = await otherClient.callTool({
    name: "polka_status",
    arguments: { uploadId: receipt.uploadId },
  });
  assert.equal(hiddenStatus.isError, true);
  assert.equal(JSON.stringify(hiddenStatus).includes(receipt.uploadId), false);
  await otherClient.close();

  const revised = (
    await client.callTool({
      name: "polka_revise",
      arguments: {
        ...prepared,
        key: randomUUID(),
        title: "MCP transport revision",
        artifactId: receipt.artifactId,
        baseRevisionId: receipt.revisionId,
      },
    })
  ).structuredContent as any;
  assert.equal(revised.artifactId, receipt.artifactId);
  assert.equal(revised.number, 2);

  const disabledInput = {
    ...prepared,
    key: randomUUID(),
    title: "Disabled preview proof",
  };
  const disabledReceipt = (
    await client.callTool({
      name: "polka_capture",
      arguments: disabledInput,
    })
  ).structuredContent as any;
  const disabled = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const {authenticateServiceToken,MCP_AUDIENCE}=await import('./apps/server/service-auth.ts');const {preparePreviewFromAgent}=await import('./apps/server/agent-preview.ts');const {db}=await import('./apps/server/db.ts');const {s3}=await import('./apps/server/storage.ts');const actor=await authenticateServiceToken(process.env.TEST_MCP_TOKEN,MCP_AUDIENCE,'capture');const before=await db.query('SELECT count(*) FROM revision_derivatives WHERE revision_id=$1',[process.env.TEST_REVISION_ID]);let status=0;try{await preparePreviewFromAgent(actor,{key:process.env.TEST_UPLOAD_KEY})}catch(error){status=error.status??500}const after=await db.query('SELECT count(*) FROM revision_derivatives WHERE revision_id=$1',[process.env.TEST_REVISION_ID]);process.stdout.write(JSON.stringify({status,before:Number(before.rows[0].count),after:Number(after.rows[0].count)}));await db.end();s3.destroy();`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HTML_LIVE_ENABLED: "false",
        TEST_MCP_TOKEN: issued.token,
        TEST_UPLOAD_KEY: disabledInput.key,
        TEST_REVISION_ID: disabledReceipt.revisionId,
      },
      encoding: "utf8",
    },
  );
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(JSON.parse(disabled.stdout), {
    status: 404,
    before: 0,
    after: 0,
  });

  const usedBeforeRevokedBuild = Number(
    (
      await db.query("SELECT derivative_used_bytes FROM tenants WHERE id=$1", [
        owner.tenant,
      ])
    ).rows[0].derivative_used_bytes,
  );
  const revokedBuildPromise = client.callTool({
    name: "polka_prepare_preview",
    arguments: { uploadId: largeReceipt.uploadId },
  });
  let pending: any;
  for (let attempt = 0; attempt < 200 && !pending; attempt++) {
    pending = (
      await db.query(
        "SELECT * FROM revision_derivatives WHERE revision_id=$1 AND state='pending'",
        [largeReceipt.revisionId],
      )
    ).rows[0];
    if (!pending) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(pending, "preview should persist its attempt before worker output");

  const revoked = await web(
    `/api/agent-connections/${issued.connection.id}/revoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-polka-csrf": csrf },
      body: "{}",
    },
  );
  assert.equal(revoked.status, 200);
  assert.equal((await revokedBuildPromise).isError, true);
  const stopped = (
    await db.query("SELECT * FROM revision_derivatives WHERE id=$1", [
      pending.id,
    ])
  ).rows[0];
  assert.equal(stopped.state, "pending");
  assert.equal(stopped.object_key, null);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT derivative_used_bytes FROM tenants WHERE id=$1",
          [owner.tenant],
        )
      ).rows[0].derivative_used_bytes,
    ),
    usedBeforeRevokedBuild,
  );
  await db.query(
    `UPDATE revision_derivatives
     SET state='failed',attempt_expires_at=NULL,reason='test cleanup'
     WHERE id=$1`,
    [pending.id],
  );
  await assert.rejects(
    client.callTool({ name: "polka_capture", arguments: captureInput }),
  );
  await client.close();
});

test("share receipts survive a lost response, reject substitution, and replay closed", async () => {
  const v1 = await saveHtml(
    "<!doctype html><title>v1</title><p>first</p>",
    "MCP share source",
  );
  const issued = await issue(["context", "share"]);
  const client = await mcpClient(issued.token);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ["polka_context", "polka_revoke_share", "polka_share", "polka_status"],
  );
  const context = (
    await client.callTool({ name: "polka_context", arguments: {} })
  ).structuredContent as any;
  assert.equal(context.capabilities.share, true);
  assert.equal(context.capabilities.readOnly, false);

  const shareInput = {
    key: randomUUID(),
    artifactId: v1.artifactId,
    expectedRevisionId: v1.revisionId,
    expiresInDays: 7,
  };
  // Deliberately discard the first successful result, then recover it by key.
  await client.callTool({ name: "polka_share", arguments: shareInput });
  const recovered = (
    await client.callTool({ name: "polka_share", arguments: shareInput })
  ).structuredContent as any;
  assert.equal(recovered.state, "active");
  assert.match(recovered.url, /^http:\/\/127\.0\.0\.1:4590\/s#/);
  assert.equal(recovered.artifactId, v1.artifactId);
  assert.equal(recovered.revisionId, v1.revisionId);
  assert.deepEqual(
    (await client.callTool({ name: "polka_share", arguments: shareInput }))
      .structuredContent,
    recovered,
  );
  const counts = await db.query(
    `SELECT
       (SELECT count(*) FROM agent_operations WHERE tenant_id=$1 AND operation='share' AND idempotency_key=$2) AS operations,
       (SELECT count(*) FROM shares WHERE tenant_id=$1 AND artifact_id=$3) AS shares`,
    [owner.tenant, shareInput.key, v1.artifactId],
  );
  assert.equal(Number(counts.rows[0].operations), 1);
  assert.equal(Number(counts.rows[0].shares), 1);

  const changedRetry = await client.callTool({
    name: "polka_share",
    arguments: { ...shareInput, expiresInDays: 1 },
  });
  assert.equal(changedRetry.isError, true);
  const otherIssued = await issue(["context", "share"]);
  const otherClient = await mcpClient(otherIssued.token);
  assert.equal(
    (
      await otherClient.callTool({
        name: "polka_share",
        arguments: shareInput,
      })
    ).isError,
    true,
  );
  await otherClient.close();

  const v2 = await saveHtml(
    "<!doctype html><title>v2</title><p>second</p>",
    "MCP share revision",
    { artifactId: v1.artifactId, revisionId: v1.revisionId },
  );
  assert.equal(
    (
      await client.callTool({
        name: "polka_share",
        arguments: { ...shareInput, key: randomUUID() },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await client.callTool({
        name: "polka_share",
        arguments: {
          ...shareInput,
          key: randomUUID(),
          expectedRevisionId: v2.revisionId,
        },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await db.query("SELECT revision_id FROM shares WHERE id=$1", [
        recovered.shareId,
      ])
    ).rows[0].revision_id,
    v1.revisionId,
  );

  assert.deepEqual(
    (
      await client.callTool({
        name: "polka_revoke_share",
        arguments: { shareId: recovered.shareId },
      })
    ).structuredContent,
    { ok: true },
  );
  const closed = (
    await client.callTool({ name: "polka_share", arguments: shareInput })
  ).structuredContent as any;
  assert.equal(closed.shareId, recovered.shareId);
  assert.equal(closed.state, "closed");
  assert.equal(closed.url, null);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM shares WHERE tenant_id=$1 AND artifact_id=$2",
          [owner.tenant, v1.artifactId],
        )
      ).rows[0].count,
    ),
    1,
  );
  const audit = (
    await db.query(
      `SELECT action,actor_type,connection_id FROM audit_outbox
       WHERE tenant_id=$1 AND target_id=$2 ORDER BY created_at`,
      [owner.tenant, recovered.shareId],
    )
  ).rows;
  assert.deepEqual(
    audit.map((row) => row.action),
    ["share.enabled", "share.revoked"],
  );
  assert(
    audit.every(
      (row) =>
        row.actor_type === "agent" &&
        row.connection_id === issued.connection.id,
    ),
  );

  const expiringInput = {
    ...shareInput,
    key: randomUUID(),
    expectedRevisionId: v2.revisionId,
    expiresInDays: 1,
  };
  const expiring = (
    await client.callTool({ name: "polka_share", arguments: expiringInput })
  ).structuredContent as any;
  await db.query(
    "UPDATE shares SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expiring.shareId],
  );
  const expiredReplay = (
    await client.callTool({ name: "polka_share", arguments: expiringInput })
  ).structuredContent as any;
  assert.equal(expiredReplay.shareId, expiring.shareId);
  assert.equal(expiredReplay.state, "closed");
  assert.equal(expiredReplay.url, null);

  const revoked = await web(
    `/api/agent-connections/${issued.connection.id}/revoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-polka-csrf": csrf },
      body: "{}",
    },
  );
  assert.equal(revoked.status, 200);
  await assert.rejects(
    client.callTool({ name: "polka_share", arguments: shareInput }),
  );
  await client.close();
});

test("scope, revoke, Host, Origin, and web Origin boundaries survive real HTTP wiring", async () => {
  const contextOnly = await issue(["context"]);
  const limited = await mcpClient(contextOnly.token);
  const limitedTools = await limited.listTools();
  assert.deepEqual(limitedTools.tools.map((tool) => tool.name).sort(), [
    "polka_context",
    "polka_status",
  ]);
  await assert.rejects(
    limited.callTool({
      name: "polka_capture",
      arguments: {},
    }),
  );
  await assert.rejects(
    limited.callTool({
      name: "polka_share",
      arguments: {},
    }),
  );
  assert.deepEqual((await limited.listResources()).resources.length, 3);
  await limited.close();

  const foreignOrigin = await fetch(MCP_AUDIENCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      origin: "https://wrong.example",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(foreignOrigin.status, 403);
  const nullOrigin = await fetch(MCP_AUDIENCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      origin: "null",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(nullOrigin.status, 403);
  const viewerOrigin = await fetch(MCP_AUDIENCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      origin: config.VIEWER_ORIGIN,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(viewerOrigin.status, 403);
  for (const authorization of [undefined, "Bearer invalid"]) {
    const missingBearer = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: new URL(config.APP_ORIGIN).host,
        ...(authorization ? { authorization } : { cookie }),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    assert.equal(missingBearer.statusCode, 401);
  }
  const wrongHost = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "wrong.example",
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(wrongHost.statusCode, 403);
  for (const path of ["/mcp/", "/mcp-anything", "/mcp%2F"])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { host: new URL(config.APP_ORIGIN).host },
          payload: {},
        })
      ).statusCode,
      403,
      path,
    );
  const queryPath = await app.inject({
    method: "POST",
    url: "/mcp?probe=1",
    headers: {
      host: new URL(config.APP_ORIGIN).host,
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(queryPath.statusCode, 200, queryPath.body);
  const securedResponse = await fetch(`${MCP_AUDIENCE}?headers=1`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }),
  });
  assert.equal(securedResponse.status, 200);
  assert.equal(securedResponse.headers.get("cache-control"), "no-store");
  assert.equal(
    securedResponse.headers.get("x-content-type-options"),
    "nosniff",
  );
  assert.equal(securedResponse.headers.get("referrer-policy"), "no-referrer");
  assert.equal(
    securedResponse.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
  );
  assert.equal(
    (
      await web(
        "/api/folders",
        {
          method: "POST",
          body: JSON.stringify({ name: "no-origin" }),
          headers: { "content-type": "application/json" },
        },
        false,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await web("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: "origin-kept" }),
        headers: { "content-type": "application/json" },
      })
    ).status,
    200,
  );

  const client = await mcpClient(bearer);
  assert.equal(
    (await client.callTool({ name: "polka_context", arguments: {} })).isError,
    undefined,
  );
  const revoked = await web(`/api/agent-connections/${connectionId}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-polka-csrf": csrf },
    body: "{}",
  });
  assert.equal(revoked.status, 200);
  await assert.rejects(
    client.callTool({ name: "polka_context", arguments: {} }),
  );
  await client.close();
});
