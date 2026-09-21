import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createAccount } from "../apps/server/auth.ts";
import { captureFromAgent } from "../apps/server/agent-capture.ts";
import {
  listTemplates,
  publishTemplate,
  sourceForAgent,
} from "../apps/server/agent-context.ts";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { createReadonlyMcpServer } from "../apps/server/mcp-readonly.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
} from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { prepareCapture } from "../scripts/prepare-capture.ts";

after(async () => {
  await db.end();
  s3.destroy();
});

test("library catalog and exact source pins match API and MCP then close on revoke", async () => {
  const password = randomBytes(24).toString("hex");
  const owner = await createAccount(`library-owner-${randomBytes(5).toString("hex")}`, password);
  const reader = await createAccount(`library-reader-${randomBytes(5).toString("hex")}`, password);
  const outsider = await createAccount(`library-outside-${randomBytes(5).toString("hex")}`, password);
  async function connection(account: typeof owner, scopes = ["source:read"]) {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    await db.query(
      `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
       VALUES($1,$2,$3,$4,'library source test',$5,$6,now()+interval '1 day')`,
      [id, account.tenant, account.id, sha256(token), scopes, MCP_AUDIENCE],
    );
    return authenticateServiceToken(token, MCP_AUDIENCE);
  }
  const ownerAgent = await connection(owner, ["capture", "source:read"]);
  const readerAgent = await connection(reader);
  const outsiderAgent = await connection(outsider);
  const metadataAgent = await connection(reader, ["context", "read"]);
  const payload = {
    ...(await prepareCapture(
      "tests/fixtures/bundle-corpus/team-report",
      "index.html",
      ["index.html", "assets/report.css", "assets/report.js", "assets/mark.svg"],
    )),
    key: randomUUID(),
    title: "Library proposal",
  };
  const receipt = await captureFromAgent(ownerAgent, payload, "capture");
  const release = await transaction((c) =>
    publishTemplate(c, owner, receipt.artifactId, {
      revisionId: receipt.revisionId,
      summary: "Proposal for a client",
      rules: "Keep the source layout.",
    }),
  );
  const libraryId = randomUUID();
  const siblingLibraryId = randomUUID();
  const publicationId = randomUUID();
  await transaction(async (c) => {
    await c.query(
      "INSERT INTO template_libraries(id,name,created_by) VALUES($1,'Team library',$2),($3,'Sibling library',$2)",
      [libraryId, owner.id, siblingLibraryId],
    );
    await c.query(
      `INSERT INTO template_library_members(library_id,account_id,role)
       VALUES($1,$2,'admin'),($1,$3,'reader'),($4,$2,'admin'),($4,$5,'reader')`,
      [libraryId, owner.id, reader.id, siblingLibraryId, outsider.id],
    );
    await c.query(
      `INSERT INTO template_library_publications(
         id,library_id,release_id,artifact_id,revision_id,publisher_id
       ) VALUES($1,$2,$3,$4,$5,$6)`,
      [publicationId, libraryId, release.releaseId, receipt.artifactId, receipt.revisionId, owner.id],
    );
  });
  const pins = {
    artifactId: receipt.artifactId,
    revisionId: receipt.revisionId,
    libraryId,
    publicationId,
  };

  assert.equal((await sourceForAgent(ownerAgent, {
    artifactId: receipt.artifactId,
    revisionId: receipt.revisionId,
  })).files.length, 4);
  await assert.rejects(
    sourceForAgent(readerAgent, {
      artifactId: receipt.artifactId,
      revisionId: receipt.revisionId,
    }),
    (error: any) => error.status === 404,
  );
  const catalog = await transaction((c) =>
    listTemplates(c, reader, { libraryId, query: "client" }),
  );
  assert.deepEqual(
    catalog.items.map(({ libraryId, publicationId, revisionId }: any) => ({
      libraryId,
      publicationId,
      revisionId,
    })),
    [{ libraryId, publicationId, revisionId: receipt.revisionId }],
  );
  assert.equal(
    (await transaction((c) => listTemplates(c, outsider, { libraryId }))).items.length,
    0,
  );
  await assert.rejects(
    sourceForAgent(readerAgent, { ...pins, libraryId: siblingLibraryId }),
    (error: any) => error.status === 404,
  );
  await assert.rejects(
    sourceForAgent(readerAgent, { ...pins, revisionId: randomUUID() }),
    (error: any) => error.status === 404,
  );
  await assert.rejects(
    sourceForAgent(metadataAgent, pins),
    (error: any) => error.status === 403,
  );

  const direct = await sourceForAgent(readerAgent, pins);
  assert.equal(direct.context.libraryId, libraryId);
  assert.equal(direct.context.publicationId, publicationId);
  const expectedCss = direct.files.find((file) => file.path === "assets/report.css")!.data;
  const server = createReadonlyMcpServer(readerAgent);
  const client = new Client({ name: "library-source", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["polka_list_template_libraries", "polka_list_templates", "polka_read_source"],
    );
    const resources = await client.listResources();
    assert.deepEqual(
      resources.resources.map((resource) => resource.uri),
      ["polka://guides/templates-v1"],
    );
    const guide = await client.readResource({ uri: "polka://guides/templates-v1" });
    assert.match((guide.contents[0] as any).text, /polka_list_template_libraries/);
    assert.match((guide.contents[0] as any).text, /polka_list_templates/);
    assert.match((guide.contents[0] as any).text, /polka_read_source/);
    const libraries = await client.callTool({
      name: "polka_list_template_libraries",
      arguments: {},
    });
    const libraryList = libraries.structuredContent as any;
    assert.equal(libraryList.hasMore, false);
    assert.deepEqual(
      libraryList.items.map(({ id, name, role }: any) => ({ id, name, role })),
      [{ id: libraryId, name: "Team library", role: "reader" }],
    );
    assert.deepEqual(
      Object.keys(libraryList.items[0]).sort(),
      ["createdAt", "id", "name", "role"],
    );
    const listed = await client.callTool({
      name: "polka_list_templates",
      arguments: { libraryId, query: "client" },
    });
    assert.equal((listed.structuredContent as any).items[0].publicationId, publicationId);
    const read = await client.callTool({ name: "polka_read_source", arguments: pins });
    const mcpCss = (read.structuredContent as any).files.find(
      (file: any) => file.path === "assets/report.css",
    );
    assert.equal(mcpCss.data, expectedCss);

    const outsiderServer = createReadonlyMcpServer(outsiderAgent);
    const outsiderClient = new Client({ name: "library-outsider", version: "1" });
    const [outsiderClientTransport, outsiderServerTransport] =
      InMemoryTransport.createLinkedPair();
    await outsiderServer.connect(outsiderServerTransport);
    await outsiderClient.connect(outsiderClientTransport);
    try {
      const outsiderLibraries = (
        await outsiderClient.callTool({
          name: "polka_list_template_libraries",
          arguments: {},
        })
      ).structuredContent as any;
      assert.deepEqual(
        outsiderLibraries.items.map(({ id }: any) => id),
        [siblingLibraryId],
      );
      assert.ok(!outsiderLibraries.items.some(({ id }: any) => id === libraryId));
    } finally {
      await outsiderClient.close();
      await outsiderServer.close();
    }

    const metadataServer = createReadonlyMcpServer(metadataAgent);
    const metadataClient = new Client({ name: "library-no-source-scope", version: "1" });
    const [metadataClientTransport, metadataServerTransport] =
      InMemoryTransport.createLinkedPair();
    await metadataServer.connect(metadataServerTransport);
    await metadataClient.connect(metadataClientTransport);
    try {
      assert.ok(
        !(await metadataClient.listTools()).tools.some(
          (tool) => tool.name === "polka_list_template_libraries",
        ),
      );
    } finally {
      await metadataClient.close();
      await metadataServer.close();
    }
  } finally {
    await client.close();
    await server.close();
  }

  const app = await createApp();
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: config.APP_ORIGIN },
      payload: { name: reader.name, password },
    });
    const cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const params = new URLSearchParams({
      revisionId: receipt.revisionId,
      libraryId,
      publicationId,
    });
    const base = `/api/artifacts/${receipt.artifactId}`;
    const context = await app.inject({ url: `${base}/agent-context?${params}`, headers: { cookie } });
    assert.equal(context.statusCode, 200, context.body);
    assert.equal(context.json().publicationId, publicationId);
    const packageResult = await app.inject({ url: `${base}/agent-package?${params}`, headers: { cookie } });
    assert.equal(packageResult.statusCode, 200, packageResult.body);
    const fileParams = new URLSearchParams(params);
    fileParams.set("path", "assets/report.css");
    const file = await app.inject({ url: `${base}/agent-file?${fileParams}`, headers: { cookie } });
    assert.equal(file.statusCode, 200, file.body);
    assert.equal(file.rawPayload.toString("base64"), expectedCss);
    const apiCatalog = await app.inject({
      url: `/api/templates?${new URLSearchParams({ libraryId, query: "client" })}`,
      headers: { cookie },
    });
    assert.equal(apiCatalog.statusCode, 200, apiCatalog.body);
    assert.equal(apiCatalog.json().items[0].publicationId, publicationId);
    const apiLibraries = await app.inject({
      url: "/api/template-libraries",
      headers: { cookie },
    });
    assert.equal(apiLibraries.statusCode, 200, apiLibraries.body);
    assert.deepEqual(
      apiLibraries.json().items.map(({ id, name, role }: any) => ({ id, name, role })),
      [{ id: libraryId, name: "Team library", role: "reader" }],
    );

    await db.query(
      `UPDATE template_library_members SET state='revoked',revoked_at=clock_timestamp()
       WHERE library_id=$1 AND account_id=$2`,
      [libraryId, reader.id],
    );
    await assert.rejects(
      sourceForAgent(readerAgent, pins),
      (error: any) => error.status === 404,
    );
    assert.equal(
      (await app.inject({ url: `${base}/agent-context?${params}`, headers: { cookie } })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: `${base}/agent-package?${params}`, headers: { cookie } })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: `${base}/agent-file?${fileParams}`, headers: { cookie } })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: `/api/templates?${new URLSearchParams({ libraryId })}`, headers: { cookie } })).json().items.length,
      0,
    );
    const revokedMembershipServer = createReadonlyMcpServer(readerAgent);
    const revokedMembershipClient = new Client({ name: "revoked-library-member", version: "1" });
    const [revokedMembershipClientTransport, revokedMembershipServerTransport] =
      InMemoryTransport.createLinkedPair();
    await revokedMembershipServer.connect(revokedMembershipServerTransport);
    await revokedMembershipClient.connect(revokedMembershipClientTransport);
    try {
      const libraries = (
        await revokedMembershipClient.callTool({
          name: "polka_list_template_libraries",
          arguments: {},
        })
      ).structuredContent as any;
      assert.deepEqual(libraries.items, []);
      await db.query(
        "UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE id=$1",
        [readerAgent.connectionId],
      );
      const revokedConnection = await revokedMembershipClient.callTool({
        name: "polka_list_template_libraries",
        arguments: {},
      });
      assert.equal(revokedConnection.isError, true);
    } finally {
      await revokedMembershipClient.close();
      await revokedMembershipServer.close();
    }
  } finally {
    await app.close();
  }
});
