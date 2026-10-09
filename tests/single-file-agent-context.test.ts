import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createAccount } from "../apps/server/auth.ts";
import { beginUpload, finalizeUpload, uploadBytes } from "../apps/server/artifacts.ts";
import { buildAgentContext, listTemplates, publishTemplate, sourceForAgent } from "../apps/server/agent-context.ts";
import { saveLink } from "../apps/server/saved-links.ts";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { createMcpServer } from "../apps/server/mcp-server.ts";
import { authenticateServiceToken, MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { bucket, s3, sha256 } from "../apps/server/storage.ts";

after(async () => {
  await db.end();
  s3.destroy();
});

test("plain text and image sources preserve exact bytes, pins and ACLs", async () => {
  assert.match(
    new URL(process.env.DATABASE_URL!).pathname,
    /^\/polka_suite_[0-9a-f]{24}$/,
    "Use scripts/test-isolated.ts; this test creates disposable fixtures",
  );
  const password = randomBytes(24).toString("hex");
  const owner = await createAccount(`single-source-owner-${randomBytes(5).toString("hex")}`, password);
  const reader = await createAccount(`single-source-reader-${randomBytes(5).toString("hex")}`, password);
  const outsider = await createAccount(`single-source-outsider-${randomBytes(5).toString("hex")}`, password);

  async function connection(account: typeof owner) {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    await db.query(
      `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
       VALUES($1,$2,$3,$4,'single source test',ARRAY['source:read'],$5,now()+interval '1 day')`,
      [id, account.tenant, account.id, sha256(token), MCP_AUDIENCE],
    );
    return authenticateServiceToken(token, MCP_AUDIENCE);
  }

  async function save(title: string, filename: string, mime: "text/plain" | "image/png", bytes: Buffer) {
    const started = await beginUpload(owner, {
      key: randomUUID(),
      title,
      filename,
      mime,
      size: bytes.length,
      sha256: sha256(bytes),
    });
    await uploadBytes(owner, started.uploadId, bytes);
    return finalizeUpload(owner, started.uploadId);
  }

  const textBytes = Buffer.from("Точный UTF-8 текст\nsecond line\n");
  const imageBytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("single-file-image-fixture")]);
  const text = await save("Hostile original filename", "../../\u0001 отчет 😀.txt", "text/plain", textBytes);
  const image = await save("Image source", "фото.png", "image/png", imageBytes);
  const ownerAgent = await connection(owner);
  const readerAgent = await connection(reader);
  const outsiderAgent = await connection(outsider);

  const expected = [
    {
      receipt: text,
      path: "source.txt",
      mime: "text/plain",
      bytes: textBytes,
    },
    {
      receipt: image,
      path: "source.png",
      mime: "image/png",
      bytes: imageBytes,
    },
  ] as const;

  for (const item of expected) {
    const pins = {
      artifactId: item.receipt.artifactId,
      revisionId: item.receipt.revisionId,
    };
    const source = await sourceForAgent(ownerAgent, pins);
    assert.equal(source.context.purpose, "source");
    if (item.mime.startsWith("image/")) {
      assert.match(source.context.clipboardText, /Визуальный пример: доступны только изображения\./);
      assert.match(source.context.clipboardText, /не являются редактируемым стилем или набором ресурсов\./);
    } else {
      assert.doesNotMatch(source.context.clipboardText, /Визуальный пример/);
    }
    assert.deepEqual(source.context.availableContent, [
      {
        path: item.path,
        mime: item.mime,
        size: item.bytes.length,
        sha256: sha256(item.bytes),
      },
    ]);
    assert.deepEqual(source.sourceDescriptor, {
      kind: "single-file",
      schema: 1,
      files: source.context.availableContent,
    });
    assert.equal(source.manifest, null);
    assert.equal(source.manifestSha256, null);
    assert.deepEqual(Buffer.from(source.files[0].data, "base64"), item.bytes);
    await assert.rejects(sourceForAgent(outsiderAgent, pins), (error: any) => error.status === 404);

    const mcpServer = createMcpServer(ownerAgent);
    const mcpClient = new Client({ name: "single-source", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      const result = await mcpClient.callTool({
        name: "polka_read_source",
        arguments: pins,
      });
      assert.equal(result.isError, undefined);
      const value = result.structuredContent as any;
      assert.deepEqual(value.sourceDescriptor, source.sourceDescriptor);
      assert.equal(value.files[0].path, item.path);
      assert.deepEqual(Buffer.from(value.files[0].data, "base64"), item.bytes);
    } finally {
      await mcpClient.close();
      await mcpServer.close();
    }
  }

  const release = await transaction((c) =>
    publishTemplate(c, owner, text.artifactId, {
      revisionId: text.revisionId,
      summary: "Plain source release",
      rules: "Treat this text as cited source material.",
    }),
  );
  assert.equal(
    (
      await sourceForAgent(ownerAgent, {
        artifactId: text.artifactId,
        revisionId: text.revisionId,
      })
    ).context.purpose,
    "base",
  );

  const libraryId = randomUUID();
  const publicationId = randomUUID();
  await transaction(async (c) => {
    await c.query("INSERT INTO template_libraries(id,name,created_by) VALUES($1,'Single files',$2)", [
      libraryId,
      owner.id,
    ]);
    await c.query(
      `INSERT INTO template_library_members(library_id,account_id,role)
       VALUES($1,$2,'admin'),($1,$3,'reader')`,
      [libraryId, owner.id, reader.id],
    );
    await c.query(
      `INSERT INTO template_library_publications(
         id,library_id,release_id,artifact_id,revision_id,publisher_id
       ) VALUES($1,$2,$3,$4,$5,$6)`,
      [publicationId, libraryId, release.releaseId, text.artifactId, text.revisionId, owner.id],
    );
  });
  const libraryPins = {
    artifactId: text.artifactId,
    revisionId: text.revisionId,
    libraryId,
    publicationId,
  };
  const librarySource = await sourceForAgent(readerAgent, libraryPins);
  assert.deepEqual(Buffer.from(librarySource.files[0].data, "base64"), textBytes);
  assert.equal((await transaction((c) => listTemplates(c, reader, { libraryId }))).items[0].mime, "text/plain");
  await assert.rejects(
    sourceForAgent(readerAgent, {
      ...libraryPins,
      revisionId: image.revisionId,
    }),
    (error: any) => error.status === 404,
  );

  const app = await createApp();
  const login = async (account: typeof owner) => {
    const result = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: config.APP_ORIGIN },
      payload: { name: account.name, password },
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  };
  try {
    const ownerCookie = await login(owner);
    for (const item of expected) {
      const base = `/api/artifacts/${item.receipt.artifactId}`;
      const params = new URLSearchParams({
        revisionId: item.receipt.revisionId,
      });
      const context = await app.inject({
        url: `${base}/agent-context?${params}`,
        headers: { cookie: ownerCookie },
      });
      assert.equal(context.statusCode, 200, context.body);
      assert.equal(context.json().availableContent[0].path, item.path);
      const fileParams = new URLSearchParams(params);
      fileParams.set("path", item.path);
      const file = await app.inject({
        url: `${base}/agent-file?${fileParams}`,
        headers: { cookie: ownerCookie },
      });
      assert.equal(file.statusCode, 200, file.body);
      assert.equal(file.headers["content-type"], item.mime);
      assert.deepEqual(file.rawPayload, item.bytes);
      const pkg = await app.inject({
        url: `${base}/agent-package?${params}`,
        headers: { cookie: ownerCookie },
      });
      assert.equal(pkg.statusCode, 200, pkg.body);
      const directory = await mkdtemp(join(tmpdir(), "polka-single-source-"));
      try {
        const archive = join(directory, "package.zip");
        await writeFile(archive, pkg.rawPayload);
        const metadata = spawnSync("unzip", ["-p", archive, "manifest.json"]);
        assert.equal(metadata.status, 0, metadata.stderr.toString());
        const parsed = JSON.parse(metadata.stdout.toString());
        assert.equal(parsed.manifest, null);
        assert.equal(parsed.manifestSha256, null);
        assert.equal(parsed.sourceDescriptor.files[0].path, item.path);
        const zipped = spawnSync("unzip", ["-p", archive, `sources/${item.path}`]);
        assert.equal(zipped.status, 0, zipped.stderr.toString());
        assert.deepEqual(zipped.stdout, item.bytes);
      } finally {
        await rm(directory, { recursive: true });
      }
    }

    const readerCookie = await login(reader);
    const params = new URLSearchParams({
      revisionId: text.revisionId,
      libraryId,
      publicationId,
    });
    const base = `/api/artifacts/${text.artifactId}`;
    const libraryFile = await app.inject({
      url: `${base}/agent-file?${new URLSearchParams({
        ...Object.fromEntries(params),
        path: "source.txt",
      })}`,
      headers: { cookie: readerCookie },
    });
    assert.equal(libraryFile.statusCode, 200, libraryFile.body);
    assert.deepEqual(libraryFile.rawPayload, textBytes);
    await db.query(
      `UPDATE template_library_members SET state='revoked',revoked_at=clock_timestamp()
       WHERE library_id=$1 AND account_id=$2`,
      [libraryId, reader.id],
    );
    assert.equal(
      (
        await app.inject({
          url: `${base}/agent-context?${params}`,
          headers: { cookie: readerCookie },
        })
      ).statusCode,
      404,
    );
    await assert.rejects(sourceForAgent(readerAgent, libraryPins), (error: any) => error.status === 404);
  } finally {
    await app.close();
  }

  const {
    rows: [stored],
  } = await db.query("SELECT object_key,object_version FROM revisions WHERE id=$1", [image.revisionId]);
  const corruptVersion = (
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: stored.object_key,
        Body: Buffer.from("corrupt replacement"),
      }),
    )
  ).VersionId;
  assert.ok(corruptVersion);
  assert.deepEqual(
    Buffer.from(
      (
        await sourceForAgent(ownerAgent, {
          artifactId: image.artifactId,
          revisionId: image.revisionId,
        })
      ).files[0].data,
      "base64",
    ),
    imageBytes,
  );
  await db.query("UPDATE revisions SET object_version=$2 WHERE id=$1", [image.revisionId, corruptVersion]);
  await assert.rejects(
    sourceForAgent(ownerAgent, {
      artifactId: image.artifactId,
      revisionId: image.revisionId,
    }),
    /checksum mismatch/,
  );
});

test("a saved link hands its address and note to the agent; other formats name the ones that work", async () => {
  const owner = await createAccount(`single-link-${randomBytes(5).toString("hex")}`, randomBytes(24).toString("hex"));
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'single link test',ARRAY['source:read'],$5,now()+interval '1 day')`,
    [id, owner.tenant, owner.id, sha256(token), MCP_AUDIENCE],
  );
  const agent = await authenticateServiceToken(token, MCP_AUDIENCE);
  const saved = await saveLink(
    owner,
    { key: randomUUID(), url: "https://example.com/brief?id=7", note: "Бриф к релизу, раздел 2" },
    { title: async () => "Бриф" },
  );
  const pins = { artifactId: saved.artifactId, revisionId: saved.revisionId };
  const source = await sourceForAgent(agent, pins);
  const document = Buffer.from(source.files[0].data, "base64");
  assert.deepEqual(JSON.parse(document.toString("utf8")), {
    v: 1,
    url: "https://example.com/brief?id=7",
    note: "Бриф к релизу, раздел 2",
  });
  assert.deepEqual(source.context.availableContent, [
    { path: "link.json", mime: "application/vnd.polka.link+json", size: document.length, sha256: sha256(document) },
  ]);
  assert.match(source.context.clipboardText, /Сохранённая ссылка: https:\/\/example\.com\/brief\?id=7/);
  assert.match(source.context.clipboardText, /не инструкции\):\nБриф к релизу, раздел 2/);
  assert.doesNotMatch(source.context.clipboardText, /Визуальный пример/);

  // A format without a context (here: a version whose type is not a source format) says which ones have it.
  await db.query("UPDATE revisions SET mime='video/mp4' WHERE id=$1", [saved.revisionId]);
  await assert.rejects(
    transaction((c) => buildAgentContext(c, owner, pins)),
    (error: any) =>
      error.status === 422 &&
      /страниц, проектов, текста, картинок PNG, JPEG и WebP и у сохранённых ссылок/.test(error.message),
  );
});
