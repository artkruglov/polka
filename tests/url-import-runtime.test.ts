import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createAccount } from "../apps/server/auth.ts";
import { db, transaction } from "../apps/server/db.ts";
import { config } from "../apps/server/config.ts";
import { s3, readBlob } from "../apps/server/storage.ts";
import {
  createImportJob,
  getImportJob,
} from "../apps/server/url-import/jobs.ts";
import { captureHtmlUrl } from "../apps/server/url-import/html-capture.ts";
import { runImportOnce } from "../apps/server/url-import/worker.ts";
import { buildInlineRevision } from "../apps/server/bundle-derivatives.ts";
import { createApp } from "../apps/server/app.ts";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";

if (!new URL(config.DATABASE_URL).pathname.startsWith("/polka_import_test_"))
  throw new Error(
    "Run through scripts/test-url-import-runtime.ts in a disposable database.",
  );
after(async () => {
  try {
    // Only exact versions referenced by this freshly created test database.
    const objects = await db.query(`
      SELECT object_key,object_version FROM revision_files
      UNION SELECT object_key,object_version FROM revisions
      UNION SELECT object_key,object_version FROM upload_files
      UNION SELECT object_key,object_version FROM revision_derivatives WHERE object_key IS NOT NULL`);
    for (const row of objects.rows)
      await s3.send(
        new DeleteObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: row.object_key,
          VersionId: row.object_version,
        }),
      );
  } finally {
    await db.end();
    s3.destroy();
  }
});

test(
  "restricted import runtime has no owner or DDL bypass",
  { skip: !process.env.URL_IMPORT_EXPECT_RUNTIME_ROLE },
  async () => {
    const identity = (
      await db.query(`SELECT current_user AS current, session_user AS session,
    rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user`)
    ).rows[0];
    assert.equal(identity.current, process.env.URL_IMPORT_EXPECT_RUNTIME_ROLE);
    assert.equal(identity.session, identity.current);
    for (const field of [
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolbypassrls",
    ])
      assert.equal(identity[field], false);
    for (const sql of [
      "CREATE TABLE public.forbidden_probe(id int)",
      "UPDATE schema_migrations SET version=version",
      "TRUNCATE url_import_jobs",
    ]) {
      await assert.rejects(
        db.query(sql),
        (error: any) => error.code === "42501",
      );
    }
  },
);

test("durable worker saves a real bundle and builds source-independent interactive HTML", async () => {
  const owner = await createAccount(
    "runtime-" + randomBytes(6).toString("hex"),
    randomBytes(24).toString("hex"),
  );
  const folderId = randomUUID();
  await db.query("INSERT INTO folders VALUES($1,$2,$3)", [
    folderId,
    owner.tenant,
    "Imported reports",
  ]);
  const input = {
    key: randomUUID(),
    url: "https://example.org/report",
    folderId,
  };
  const job = await transaction((c) => createImportJob(c, owner, input));
  const sources: Record<string, [string, string]> = {
    "https://example.org/report": [
      "text/html",
      '<!doctype html><title>Local report</title><link rel="stylesheet" href="report.css"><button id="counter">0</button><script src="report.js"></script>',
    ],
    "https://example.org/report.css": ["text/css", "body{color:rgb(24,24,24)}"],
    "https://example.org/report.js": [
      "text/javascript",
      "document.getElementById('counter').onclick=function(){this.textContent=Number(this.textContent)+1}",
    ],
  };
  let downloads = 0;
  const prepare = (url: string) =>
    captureHtmlUrl(url, {
      fetcher: async (address) => {
        downloads++;
        const item = sources[address];
        assert.ok(item);
        return {
          url: address,
          contentType: item[0],
          bytes: Buffer.from(item[1]),
        };
      },
    });
  assert.equal(await runImportOnce({ prepare }), true);
  const saved = await transaction((c) => getImportJob(c, owner, job.id));
  assert.equal(saved.state, "previewing", saved.error_code);
  assert.ok(saved.receipt.revisionId);
  assert.equal(
    (
      await db.query("SELECT folder_id FROM artifacts WHERE id=$1", [
        saved.receipt.artifactId,
      ])
    ).rows[0].folder_id,
    folderId,
  );
  assert.equal(saved.prepared, null);
  assert.equal(downloads, 3);
  // A second worker invocation recovers the saved copy and prepares preview.
  for (const key of Object.keys(sources)) delete sources[key];
  assert.equal(await runImportOnce({ prepare }), true);
  const complete = await transaction((c) => getImportJob(c, owner, job.id));
  assert.equal(complete.state, "ready", complete.error_code);
  assert.equal(downloads, 3);
  assert.equal(await runImportOnce({ prepare }), false);
  const duplicate = await transaction((c) => createImportJob(c, owner, input));
  assert.deepEqual(duplicate.receipt, saved.receipt);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM artifacts WHERE tenant_id=$1",
        [owner.tenant],
      )
    ).rows[0].n,
    1,
  );
  // Simulate an unavailable source: build reads only stored revision files.
  for (const key of Object.keys(sources)) delete sources[key];
  const built = await buildInlineRevision(owner, saved.receipt.revisionId);
  assert.equal(built.status.state, "ready", JSON.stringify(built.status));
  const derivative = (
    await db.query(
      "SELECT object_key,object_version FROM revision_derivatives WHERE revision_id=$1 AND state='ready'",
      [saved.receipt.revisionId],
    )
  ).rows[0];
  const html = (
    await readBlob(derivative.object_key, derivative.object_version)
  ).toString();
  assert.match(html, /getElementById\('counter'\)/);
  assert.match(html, /rgb\(24,24,24\)/);
  assert.doesNotMatch(html, /src="report.js"|href="report.css"/);
});

test("enabled HTTP gateway authenticates, deduplicates and cancels jobs", async () => {
  const password = randomBytes(24).toString("hex");
  const name = "gateway-" + randomBytes(6).toString("hex");
  const owner = await createAccount(name, password);
  const app = await createApp();
  try {
    await app.ready();
    const capability = await app.inject({
      method: "GET",
      url: "/api/imports/capabilities",
    });
    assert.equal(capability.json().enabled, true);
    assert.equal(capability.json().providerArtifacts, false);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: config.APP_ORIGIN },
      payload: { name, password },
    });
    assert.equal(login.statusCode, 200);
    const cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
    const headers = { origin: config.APP_ORIGIN, cookie };
    const payload = { key: randomUUID(), url: "https://example.org/report" };
    const other = await createAccount("folder-other-" + randomBytes(6).toString("hex"), password);
    const foreignFolder = randomUUID();
    await db.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$2,$3)", [foreignFolder, other.tenant, "private folder"]);
    for (const folderId of [foreignFolder, randomUUID()]) {
      const rejected = await app.inject({method: "POST", url: "/api/imports", headers,
        payload: {...payload, folderId}});
      assert.equal(rejected.statusCode, 404, rejected.body);
      assert.equal(rejected.body.includes("private folder"), false);
      const queued = await db.query("SELECT count(*)::int n FROM url_import_jobs WHERE tenant_id=$1 AND idempotency_key=$2", [owner.tenant, payload.key]);
      assert.equal(queued.rows[0].n, 0, "Unavailable destination must not silently enqueue a root import");
    }

    const invalid = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers,
      payload: { ...payload, url: "http://example.org/report" },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().code, "invalid");
    const denied = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: { origin: config.APP_ORIGIN },
      payload,
    });
    assert.equal(denied.statusCode, 401);
    const created = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers,
      payload,
    });
    assert.equal(created.statusCode, 200, created.body);
    const id = created.json().id;
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers,
      payload,
    });
    assert.equal(duplicate.json().id, id);
    const cancelled = await app.inject({
      method: "DELETE",
      url: `/api/imports/${id}`,
      headers,
    });
    assert.equal(cancelled.json().state, "cancelled", cancelled.body);
    const status = await app.inject({
      method: "GET",
      url: `/api/imports/${id}`,
      headers,
    });
    assert.equal(status.json().state, "cancelled");
    assert.equal(status.body.includes(payload.url), false);
    assert.equal(status.body.includes("lease_token"), false);
  } finally {
    await app.close();
  }
});

test("preview failure preserves the saved receipt instead of reporting lost import", async () => {
  const owner = await createAccount(
    "quota-" + randomBytes(6).toString("hex"),
    randomBytes(24).toString("hex"),
  );
  const job = await transaction((c) =>
    createImportJob(c, owner, {
      key: randomUUID(),
      url: "https://example.org/quota",
    }),
  );
  const prepare = (url: string) =>
    captureHtmlUrl(url, {
      fetcher: async (address) => ({
        url: address,
        contentType: "text/html",
        bytes: Buffer.from("<h1>Saved copy</h1>"),
      }),
    });
  await runImportOnce({ prepare });
  const saved = await transaction((c) => getImportJob(c, owner, job.id));
  assert.equal(saved.state, "previewing");
  await db.query("UPDATE tenants SET derivative_quota_bytes=0 WHERE id=$1", [
    owner.tenant,
  ]);
  await runImportOnce({
    prepare: async () => {
      throw Error("must not download again");
    },
  });
  const partial = await transaction((c) => getImportJob(c, owner, job.id));
  assert.equal(partial.state, "partial");
  assert.deepEqual(partial.receipt, saved.receipt);
  assert.equal(partial.error_code, "quota");
});

test("MCP transport exposes scoped URL import and reports the saved interactive copy", async () => {
  const { Client, StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/client");
  const { MCP_AUDIENCE } = await import("../apps/server/service-auth.ts");
  const password = randomBytes(24).toString("hex");
  const name = "mcp-url-" + randomBytes(6).toString("hex");
  const owner = await createAccount(name, password);
  const app = await createApp();
  const clients: InstanceType<typeof Client>[] = [];
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: config.APP_ORIGIN },
      payload: { name, password },
    });
    assert.equal(login.statusCode, 200);
    const headers = {
      origin: config.APP_ORIGIN,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
    };
    const csrf = await app.inject({
      method: "POST",
      url: "/api/agent-connections/csrf",
      headers,
      payload: {},
    });
    const connect = async (scopes: string[]) => {
      const issued = await app.inject({
        method: "POST",
        url: "/api/agent-connections",
        headers: { ...headers, "x-polka-csrf": csrf.json().csrfToken },
        payload: { name: "URL test", scopes, audience: MCP_AUDIENCE },
      });
      assert.equal(issued.statusCode, 200, issued.body);
      const client = new Client(
        { name: "url-import-test", version: "1.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(MCP_AUDIENCE), {
          authProvider: { token: async () => issued.json().token },
          onInsufficientScope: "throw",
        }),
      );
      return { client, connection: issued.json().connection };
    };
    const reader = await connect(["read"]);
    assert.equal(
      (await reader.client.listTools()).tools.some(
        (t) => t.name === "polka_import_url",
      ),
      false,
    );
    const agent = await connect(["capture"]);
    assert.ok(
      (await agent.client.listTools()).tools.some(
        (t) => t.name === "polka_import_url",
      ),
    );
    const liveSource = process.env.URL_IMPORT_PUBLIC_SOURCE_CHECK === "true";
    const input = {
      key: randomUUID(),
      url: liveSource
        ? "https://mdn.github.io/learning-area/javascript/building-blocks/events/random-color-addeventlistener.html"
        : "https://example.org/mcp-report",
    };
    const created = await agent.client.callTool({
      name: "polka_import_url",
      arguments: input,
    });
    assert.equal(created.isError, undefined);
    const job = created.structuredContent as any;
    assert.equal(job.state, "queued");
    if (liveSource) {
      // Exercise the actual HTTPS downloader; no fixture injection or DB state edits.
      await runImportOnce();
    } else {
      const prepared = await captureHtmlUrl(input.url, {
        fetcher: async (url) => ({
          url,
          contentType: "text/html",
          bytes: Buffer.from("<h1>MCP saved report</h1>"),
        }),
      });
      // Supply a deterministic downloaded snapshot; transport and persistence are real.
      await db.query(
        "UPDATE url_import_jobs SET state='prepared',prepared=$2 WHERE id=$1",
        [job.id, prepared],
      );
      await runImportOnce({
        prepare: async () => {
          throw Error("snapshot should be used");
        },
      });
    }
    await runImportOnce();
    const status = await agent.client.callTool({
      name: "polka_import_status",
      arguments: { id: job.id },
    });
    assert.equal(status.isError, undefined);
    const result = status.structuredContent as any;
    assert.equal(result.state, "ready", JSON.stringify(result));
    assert.ok(result.receipt.revisionId);
    const retry = await agent.client.callTool({
      name: "polka_import_url",
      arguments: input,
    });
    assert.equal(retry.isError, undefined);
    assert.equal((retry.structuredContent as any).id, job.id);
    assert.deepEqual((retry.structuredContent as any).receipt, result.receipt);
    if (liveSource) {
      const revision = (
        await db.query(
          "SELECT object_key,object_version,manifest FROM revisions WHERE id=$1",
          [result.receipt.revisionId],
        )
      ).rows[0];
      const bytes = await readBlob(
        revision.object_key,
        revision.object_version,
      );
      assert.match(bytes.toString(), /Change color/);
      assert.equal(revision.manifest.provenance.sourceUrl, input.url);
      const derivative = (await db.query(
        "SELECT object_key,object_version FROM revision_derivatives WHERE revision_id=$1 AND state='ready'",
        [result.receipt.revisionId],
      )).rows[0];
      assert.ok(derivative, "Public import must persist a ready viewer derivative");
      const viewerHtml = (await readBlob(derivative.object_key, derivative.object_version)).toString();
      assert.match(viewerHtml, /Change color/);
      assert.match(viewerHtml, /addEventListener/);
      assert.match(viewerHtml, /backgroundColor/);

      console.log(
        JSON.stringify({
          event: "url-import.public-source-mcp",
          source: input.url,
          state: result.state,
          bytes: bytes.length,
          idempotent: true,
          fixtureInjected: false,
          storedViewerBytes: Buffer.byteLength(viewerHtml),
          storedInteractiveCode: true,
        }),
      );
    }
    const sibling = await connect(["capture"]);
    assert.equal(
      (
        await sibling.client.callTool({
          name: "polka_import_status",
          arguments: { id: job.id },
        })
      ).isError,
      true,
    );
    const cancelled = await agent.client.callTool({
      name: "polka_cancel_import",
      arguments: { id: job.id },
    });
    assert.equal((cancelled.structuredContent as any).state, "ready");
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM artifacts WHERE tenant_id=$1",
          [owner.tenant],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.close();
  }
});
