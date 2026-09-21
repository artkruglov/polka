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
import {
  beginUpload,
  finalizeUpload,
  uploadBytes,
} from "../apps/server/artifacts.ts";
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
import { bucket, s3, sha256 } from "../apps/server/storage.ts";

after(async () => {
  await db.end();
  s3.destroy();
});

test("plain text and image sources preserve exact bytes, pins and ACLs", async () => {
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/polka_suite_[0-9a-f]{24}$/, "Use scripts/test-isolated.ts; this test creates disposable fixtures");
  const password = randomBytes(24).toString("hex");
  const owner = await createAccount(
    `single-source-owner-${randomBytes(5).toString("hex")}`,
    password,
  );
  const reader = await createAccount(
    `single-source-reader-${randomBytes(5).toString("hex")}`,
    password,
  );
  const outsider = await createAccount(
    `single-source-outsider-${randomBytes(5).toString("hex")}`,
    password,
  );

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

  async function save(
    title: string,
    filename: string,
    mime: "text/plain" | "image/png",
    bytes: Buffer,
  ) {
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
  const imageBytes = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from("single-file-image-fixture"),
  ]);
  const text = await save(
    "Hostile original filename",
    "../../\u0001 отчет 😀.txt",
    "text/plain",
    textBytes,
  );
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
      assert.match(
        source.context.clipboardText,
        /Визуальный пример: доступны только изображения\./,
      );
      assert.match(
        source.context.clipboardText,
        /не являются редактируемым стилем или набором ресурсов\./,
      );
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
    await assert.rejects(
      sourceForAgent(outsiderAgent, pins),
      (error: any) => error.status === 404,
    );

    const mcpServer = createReadonlyMcpServer(ownerAgent);
    const mcpClient = new Client({ name: "single-source", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
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
    await c.query(
      "INSERT INTO template_libraries(id,name,created_by) VALUES($1,'Single files',$2)",
      [libraryId, owner.id],
    );
    await c.query(
      `INSERT INTO template_library_members(library_id,account_id,role)
       VALUES($1,$2,'admin'),($1,$3,'reader')`,
      [libraryId, owner.id, reader.id],
    );
    await c.query(
      `INSERT INTO template_library_publications(
         id,library_id,release_id,artifact_id,revision_id,publisher_id
       ) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        publicationId,
        libraryId,
        release.releaseId,
        text.artifactId,
        text.revisionId,
        owner.id,
      ],
    );
  });
  const libraryPins = {
    artifactId: text.artifactId,
    revisionId: text.revisionId,
    libraryId,
    publicationId,
  };
  const librarySource = await sourceForAgent(readerAgent, libraryPins);
  assert.deepEqual(
    Buffer.from(librarySource.files[0].data, "base64"),
    textBytes,
  );
  assert.equal(
    (await transaction((c) => listTemplates(c, reader, { libraryId }))).items[0]
      .mime,
    "text/plain",
  );
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
    return result.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
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
        const zipped = spawnSync("unzip", [
          "-p",
          archive,
          `sources/${item.path}`,
        ]);
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
    await assert.rejects(
      sourceForAgent(readerAgent, libraryPins),
      (error: any) => error.status === 404,
    );
  } finally {
    await app.close();
  }

  const {
    rows: [stored],
  } = await db.query(
    "SELECT object_key,object_version FROM revisions WHERE id=$1",
    [image.revisionId],
  );
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
  await db.query("UPDATE revisions SET object_version=$2 WHERE id=$1", [
    image.revisionId,
    corruptVersion,
  ]);
  await assert.rejects(
    sourceForAgent(ownerAgent, {
      artifactId: image.artifactId,
      revisionId: image.revisionId,
    }),
    /checksum mismatch/,
  );
});
