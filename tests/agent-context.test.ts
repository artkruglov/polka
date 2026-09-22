import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "../apps/server/mcp-server.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount } from "../apps/server/auth.ts";
import { db, transaction } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
} from "../apps/server/service-auth.ts";
import { captureFromAgent } from "../apps/server/agent-capture.ts";
import { prepareCapture } from "../scripts/prepare-capture.ts";
import {
  sourceForAgent,
  buildAgentContext,
  publishTemplate,
  listTemplates,
} from "../apps/server/agent-context.ts";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { zipFiles } from "../apps/server/zip-files.ts";
after(async () => {
  await db.end();
  s3.destroy();
});
test("exact source context, immutable template, explicit scope, tenant isolation and revocation", async () => {
  const password = randomBytes(24).toString("hex"),
    owner = await createAccount(
      "context-" + randomBytes(5).toString("hex"),
      password,
    ),
    other = await createAccount(
      "context-" + randomBytes(5).toString("hex"),
      password,
    );
  async function connection(scopes: string[], account = owner) {
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    await db.query(
      `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at) VALUES($1,$2,$3,$4,'context test',$5,$6,now()+interval '1 day')`,
      [id, account.tenant, account.id, sha256(token), scopes, MCP_AUDIENCE],
    );
    return authenticateServiceToken(token, MCP_AUDIENCE);
  }
  const agent = await connection([
    "context",
    "capture",
    "revise",
    "source:read",
  ]);
  const payload = {
    ...(await prepareCapture(
      "tests/fixtures/bundle-corpus/team-report",
      "index.html",
      [
        "index.html",
        "assets/report.css",
        "assets/report.js",
        "assets/mark.svg",
      ],
    )),
    key: randomUUID(),
    title: "Same title",
  };
  const receipt = await captureFromAgent(agent, payload, "capture");
  const input = {
    artifactId: receipt.artifactId,
    revisionId: receipt.revisionId,
  };
  const server = createMcpServer(agent),
    client = new Client({ name: "context-acceptance", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert(tools.tools.some((t) => t.name === "polka_read_source"));
    const output = await client.callTool({
      name: "polka_read_source",
      arguments: input,
    });
    assert.equal(output.isError, undefined);
    const value = output.structuredContent as any;
    assert.equal(value.context.revisionId, receipt.revisionId);
    assert.equal(value.files.length, 4);
  } finally {
    await client.close();
    await server.close();
  }
  const initial = await sourceForAgent(agent, input);
  assert.equal(initial.context.purpose, "source");
  assert.equal(initial.files.length, 4);
  assert(
    initial.files.some(
      (f) =>
        f.path === "assets/report.css" &&
        Buffer.from(f.data, "base64").length === f.size,
    ),
  );
  const releaseInput = {
    revisionId: receipt.revisionId,
    summary: "Еженедельный отчёт",
    rules: "Используйте корпоративные цвета. Демо-цифры замените.",
    questions: "Какой период, где источник цифр?",
  };
  const release = await transaction((c) =>
    publishTemplate(c, owner, receipt.artifactId, releaseInput),
  );
  assert.deepEqual(
    await transaction((c) =>
      publishTemplate(c, owner, receipt.artifactId, releaseInput),
    ),
    release,
  );
  await assert.rejects(
    transaction((c) =>
      publishTemplate(c, owner, receipt.artifactId, {
        ...releaseInput,
        rules: "Other",
      }),
    ),
    (e: any) => e.status === 409,
  );
  const base = await sourceForAgent(agent, input);
  assert.equal(base.context.purpose, "base");
  assert.equal(base.context.releaseId, release.releaseId);
  assert(base.context.clipboardText.includes(receipt.revisionId));
  assert(base.context.clipboardText.includes(releaseInput.questions));
  assert.equal(
    (await sourceForAgent(agent, { ...input, purpose: "style" })).context
      .purpose,
    "style",
  );
  assert.equal(
    (await transaction((c) => listTemplates(c, other))).items.length,
    0,
  );
  const metadata = await connection(["context", "read"]);
  await assert.rejects(
    sourceForAgent(metadata, input),
    (e: any) => e.status === 403,
  );
  const foreign = await connection(["source:read"], other);
  await assert.rejects(
    sourceForAgent(foreign, input),
    (e: any) => e.status === 404,
  );
  await assert.rejects(
    sourceForAgent(agent, { ...input, artifactId: randomUUID() }),
    (e: any) => e.status === 404,
  );
  const next = await captureFromAgent(
    agent,
    {
      ...payload,
      key: randomUUID(),
      artifactId: receipt.artifactId,
      baseRevisionId: receipt.revisionId,
      title: "Renamed",
    },
    "revise",
  );
  assert.notEqual(next.revisionId, receipt.revisionId);
  assert.equal(
    (await sourceForAgent(agent, input)).context.revisionId,
    receipt.revisionId,
  );
  assert.equal(
    (await sourceForAgent(agent, { ...input, revisionId: next.revisionId }))
      .context.releaseId,
    null,
  );
  await transaction((c) =>
    publishTemplate(c, owner, receipt.artifactId, {
      revisionId: next.revisionId,
      summary: "Предложение клиенту: рост 25%_",
      rules: "Сохраните оформление, используйте данные клиента.",
    }),
  );
  const latest = await transaction((c) => listTemplates(c, owner));
  assert.equal(latest.items.length, 1);
  assert.equal(latest.items[0].revisionId, next.revisionId);
  assert.equal(latest.items[0].isLatest, true);
  assert.equal(latest.hasMore, false);
  // Filter after picking the latest release: an old matching description must
  // never silently substitute for the current template.
  assert.equal(
    (
      await transaction((c) =>
        listTemplates(c, owner, { query: "Еженедельный" }),
      )
    ).items.length,
    0,
  );
  const history = await transaction((c) =>
    listTemplates(c, owner, { query: "Еженедельный", includePrevious: true }),
  );
  assert.equal(history.items[0].revisionId, receipt.revisionId);
  assert.equal(history.items[0].isLatest, false);
  assert.equal(
    (
      await transaction((c) =>
        listTemplates(c, other, {
          query: "Предложение",
          includePrevious: true,
        }),
      )
    ).items.length,
    0,
  );
  assert.equal(
    (await transaction((c) => listTemplates(c, owner, { query: "%_" }))).items
      .length,
    1,
  );
  assert.equal(
    (await transaction((c) => listTemplates(c, owner, { query: "%missing_" })))
      .items.length,
    0,
  );
  const searchServer = createMcpServer(agent),
    searchClient = new Client({ name: "template-search", version: "1" });
  const [searchTransport, searchServerTransport] =
    InMemoryTransport.createLinkedPair();
  await searchServer.connect(searchServerTransport);
  await searchClient.connect(searchTransport);
  try {
    const result = await searchClient.callTool({
      name: "polka_list_templates",
      arguments: { query: "клиенту" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      (result.structuredContent as any).items[0].revisionId,
      next.revisionId,
    );
  } finally {
    await searchClient.close();
    await searchServer.close();
  }
  const app = await createApp();
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: config.APP_ORIGIN },
      payload: { name: owner.name, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.cookies.map((x) => `${x.name}=${x.value}`).join("; ");
    const found = await app.inject({
      url: `/api/templates?${new URLSearchParams({ query: "Еженедельный", includePrevious: "true" })}`,
      headers: { cookie },
    });
    assert.equal(found.statusCode, 200, found.body);
    assert.equal(found.json().items[0].revisionId, receipt.revisionId);
    const invalid = await app.inject({
      url: "/api/templates?includePrevious=anything",
      headers: { cookie },
    });
    assert.equal(invalid.statusCode, 400);
    const url = `/api/artifacts/${receipt.artifactId}/agent-context?revisionId=${receipt.revisionId}`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const res = await app.inject({ url, headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().releaseId, release.releaseId);
    const pkg = await app.inject({
      url: `/api/artifacts/${receipt.artifactId}/agent-package?revisionId=${receipt.revisionId}`,
      headers: { cookie },
    });
    assert.equal(pkg.statusCode, 200, pkg.body);
    const dir = await mkdtemp(join(tmpdir(), "polka-context-"));
    try {
      const file = join(dir, "package.zip");
      await writeFile(file, pkg.rawPayload);
      const checked = spawnSync("unzip", ["-t", file]);
      assert.equal(checked.status, 0, checked.stdout.toString());
      const context = spawnSync("unzip", ["-p", file, "context.md"]);
      assert(context.stdout.toString().includes(receipt.revisionId));
      const css = spawnSync("unzip", ["-p", file, "sources/assets/report.css"]);
      assert.deepEqual(
        css.stdout,
        Buffer.from(
          base.files.find((f) => f.path === "assets/report.css")!.data,
          "base64",
        ),
      );
    } finally {
      await rm(dir, { recursive: true });
    }
    const single = await app.inject({
      url: `/api/artifacts/${receipt.artifactId}/agent-file?revisionId=${receipt.revisionId}&path=assets%2Freport.css`,
      headers: { cookie },
    });
    assert.equal(single.statusCode, 200);
    assert(single.headers["content-disposition"]?.includes("attachment"));
    await db.query("UPDATE artifacts SET trashed_at=now() WHERE id=$1", [
      receipt.artifactId,
    ]);
    assert.equal(
      (await app.inject({ url, headers: { cookie } })).statusCode,
      404,
    );
    await assert.rejects(
      sourceForAgent(agent, input),
      (e: any) => e.status === 404,
    );
  } finally {
    await app.close();
  }
  await db.query("UPDATE agent_connections SET revoked_at=now() WHERE id=$1", [
    agent.connectionId,
  ]);
  await assert.rejects(
    sourceForAgent(agent, input),
    (e: any) => e.status === 401,
  );
});
test("ZIP export refuses traversal", () =>
  assert.throws(() =>
    zipFiles([{ path: "../escape", bytes: Buffer.from("x") }]),
  ));
