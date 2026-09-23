import { test, before, after } from "node:test";
import { withNewTabLinks } from "../apps/server/html.ts";
import { verifyAwayToken } from "../apps/server/away-links.ts";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFrontend } from "../apps/server/frontend.ts";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  createApp,
  RESOLVE_LIMIT_PER_IP,
  TRANSFER_SLOTS,
} from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  s3,
  bucket,
  sha256,
  putImmutable,
  readBlob,
} from "../apps/server/storage.ts";
const app = await createApp();
const origin = config.APP_ORIGIN;
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error(
    "Integration fixtures are only allowed on a local development installation",
  );
let a: any,
  b: any,
  ca = "",
  cb = "";
const password = randomBytes(24).toString("hex");
// Isolate persistent IP rate limits across repeated local test runs.
const testRemoteAddress = `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
async function call(method: any, url: string, body?: any, cookie = ca) {
  return app.inject({
    remoteAddress: testRemoteAddress,
    method,
    url,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(Buffer.isBuffer(body)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    payload: body,
  });
}
async function save(
  text: string,
  patch: Record<string, unknown> = {},
  cookie = ca,
) {
  const bytes = Buffer.from(text);
  const input = {
    key: randomUUID(),
    title: "Новая работа",
    filename: "report.txt",
    mime: "text/plain",
    size: bytes.length,
    sha256: sha256(bytes),
    ...patch,
  };
  const begin = await call("POST", "/api/uploads", input, cookie);
  assert.equal(begin.statusCode, 200, begin.body);
  const { uploadId } = begin.json();
  const put = await call(
    "PUT",
    `/api/uploads/${uploadId}/bytes`,
    bytes,
    cookie,
  );
  assert.equal(put.statusCode, 200, put.body);
  const finish = await call(
    "POST",
    `/api/uploads/${uploadId}/finalize`,
    {},
    cookie,
  );
  assert.equal(finish.statusCode, 200, finish.body);
  return { receipt: finish.json(), input, uploadId };
}
async function grant(token: string) {
  const r = await call("POST", "/api/resolve", { token }, "");
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function content(grant: string) {
  return app.inject({
    url: "/api/view/bytes",
    headers: { authorization: `Bearer ${grant}` },
  });
}
before(async () => {
  const suffix = randomBytes(5).toString("hex");
  a = await createAccount(`test-a-${suffix}`, password);
  b = await createAccount(`test-b-${suffix}`, password);
  const ra = await call("POST", "/api/login", { name: a.name, password }, "");
  assert.equal(ra.statusCode, 200);
  ca = ra.cookies[0].name + "=" + ra.cookies[0].value;
  const rb = await call("POST", "/api/login", { name: b.name, password }, "");
  assert.equal(rb.statusCode, 200);
  cb = rb.cookies[0].name + "=" + rb.cookies[0].value;
});
after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("Real S3: conditional writes refuse replacement and version-pinned reads retain exact bytes", async () => {
  const key = `contract-tests/${randomUUID()}`,
    bytes = Buffer.from("immutable version");
  const v = await putImmutable(key, bytes);
  assert.equal(await putImmutable(key, bytes), v);
  assert.equal((await readBlob(key, v)).toString(), bytes.toString());
  await assert.rejects(
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: "replacement",
        IfNoneMatch: "*",
      }),
    ),
    (e: any) => e.$metadata.httpStatusCode === 412,
  );
});
test("Private upload persists with receipt; duplicate begin/finalize creates one revision and audit event", async () => {
  const saved = await save("Итоги недели\nЗапустили первую рабочую полку.");
  const retry = await call("POST", "/api/uploads", saved.input);
  assert.deepEqual(retry.json().receipt, saved.receipt);
  assert.deepEqual(
    (await call("POST", `/api/uploads/${saved.uploadId}/finalize`, {})).json(),
    saved.receipt,
  );
  const artifact = (
    await call("GET", `/api/artifacts/${saved.receipt.artifactId}`)
  ).json();
  assert.equal(artifact.share, null);
  assert.equal(
    (await call("GET", `/api/artifacts/${artifact.id}/revisions`)).json()
      .length,
    1,
  );
  assert.equal(
    +(
      await db.query("SELECT count(*) FROM audit_outbox WHERE target_id=$1", [
        saved.receipt.revisionId,
      ])
    ).rows[0].count,
    1,
  );
  const altered = await call("POST", "/api/uploads", {
    ...saved.input,
    title: "Different",
  });
  assert.equal(altered.statusCode, 409);
});

test("Artifact metadata rename and move preserve revisions and shares", async () => {
  const saved = await save("Metadata stays immutable", { title: "Before" });
  const folder = (
    await call("POST", "/api/folders", { name: `moved-${randomUUID()}` })
  ).json();
  const shared = await call(
    "POST",
    `/api/artifacts/${saved.receipt.artifactId}/share`,
    {
      expectedRevisionId: saved.receipt.revisionId,
      expiresInDays: 1,
    },
  );
  assert.equal(shared.statusCode, 200, shared.body);
  const before = (
    await call("GET", `/api/artifacts/${saved.receipt.artifactId}`)
  ).json();
  const moved = await call(
    "PATCH",
    `/api/artifacts/${saved.receipt.artifactId}`,
    {
      title: "After",
      folderId: folder.id,
      expectedTitle: "Before",
      expectedFolderId: null,
    },
  );
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().title, "After");
  assert.equal(moved.json().folderId, folder.id);
  assert.equal(moved.json().revision.sha256, before.revision.sha256);
  assert.equal(moved.json().revision.id, before.revision.id);
  assert.equal(moved.json().share.id, before.share.id);
  assert.equal(
    +(
      await db.query(
        "SELECT count(*) FROM audit_outbox WHERE action=$1 AND target_id=$2",
        ["artifact.metadata_updated", saved.receipt.artifactId],
      )
    ).rows[0].count,
    1,
  );
  assert.equal(
    (
      await call("PATCH", `/api/artifacts/${saved.receipt.artifactId}`, {
        title: "Stale",
        expectedTitle: "Before",
        expectedFolderId: null,
      })
    ).statusCode,
    409,
  );
  const foreignFolder = (
    await call("POST", "/api/folders", { name: `foreign-${randomUUID()}` }, cb)
  ).json();
  assert.equal(
    (
      await call("PATCH", `/api/artifacts/${saved.receipt.artifactId}`, {
        folderId: foreignFolder.id,
        expectedTitle: "After",
        expectedFolderId: folder.id,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call("PATCH", `/api/artifacts/${saved.receipt.artifactId}`, {
        folderId: null,
        expectedTitle: "After",
        expectedFolderId: folder.id,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "PATCH",
        `/api/artifacts/${saved.receipt.artifactId}`,
        {
          title: "No access",
          expectedTitle: "After",
          expectedFolderId: null,
        },
        cb,
      )
    ).statusCode,
    404,
  );
});
test("Two accounts and anonymous clients cannot obtain private title, revision, receipt or foreign folder", async () => {
  const { receipt, uploadId } = await save("Confidential text", {
    title: "Private-only title",
  });
  for (const cookie of [cb, ""])
    for (const path of [
      `/api/artifacts/${receipt.artifactId}`,
      `/api/revisions/${receipt.revisionId}/bytes`,
      `/api/uploads/${uploadId}`,
    ]) {
      const r = await call("GET", path, undefined, cookie);
      assert.ok([401, 404].includes(r.statusCode));
      assert.ok(!r.body.includes("Private-only title"));
    }
  assert.equal(
    (await call("GET", "/api/artifacts", undefined, cb)).json().items.length,
    0,
  );
  const folder = (
    await call("POST", "/api/folders", { name: `private-${randomUUID()}` })
  ).json();
  const input = {
    key: randomUUID(),
    title: "test",
    filename: "a.txt",
    mime: "text/plain",
    size: 1,
    sha256: sha256("a"),
    folderId: folder.id,
  };
  assert.equal((await call("POST", "/api/uploads", input, cb)).statusCode, 404);
});
test("Checksum, real media type, UTF-8 and unsupported HTML are enforced on server", async () => {
  for (const [mime, body, hash] of [
    ["image/png", Buffer.from("not an image"), undefined],
    ["text/plain", Buffer.from([255]), undefined],
    ["text/plain", Buffer.from("valid"), sha256("wrong")],
  ] as const) {
    const u = (
      await call("POST", "/api/uploads", {
        key: randomUUID(),
        title: "bad",
        filename: "a",
        mime,
        size: body.length,
        sha256: hash ?? sha256(body),
      })
    ).json();
    assert.equal(
      (await call("PUT", `/api/uploads/${u.uploadId}/bytes`, body)).statusCode,
      422,
    );
    await call("DELETE", `/api/uploads/${u.uploadId}`);
  }
  const html = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "HTML",
    filename: "a.html",
    mime: "text/html",
    size: 1,
    sha256: sha256("a"),
  });
  assert.equal(html.statusCode, 200);
  assert.equal(
    (
      await call(
        "PUT",
        `/api/uploads/${html.json().uploadId}/bytes`,
        Buffer.from("a"),
      )
    ).statusCode,
    422,
  );
});
test("Static HTML is served in a sandbox, while unsupported HTML cannot be shared; recipient can report", async () => {
  const body = Buffer.from(
    '<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body><h1>Saved page</h1><p>Independent copy.</p><a href="https://example.org/source">Источник</a></body></html>',
  );
  const input = {
    key: randomUUID(),
    title: "Saved HTML",
    filename: "page.html",
    mime: "text/html",
    size: body.length,
    sha256: sha256(body),
  } as const;
  const begin = await call("POST", "/api/uploads", input);
  assert.equal(begin.statusCode, 200, begin.body);
  const uploadId = begin.json().uploadId;
  assert.equal(
    (await call("PUT", `/api/uploads/${uploadId}/bytes`, body)).statusCode,
    200,
  );
  const receipt = (
    await call("POST", `/api/uploads/${uploadId}/finalize`, {})
  ).json();
  assert.equal(receipt.htmlProfile, "static");
  const document = await call(
    "GET",
    `/api/revisions/${receipt.revisionId}/document`,
  );
  assert.equal(document.statusCode, 200, document.body);
  assert.match(
    document.headers["content-security-policy"] as string,
    /sandbox/,
  );
  // The static view copies the page as is, except that external links go
  // through the signed "you are leaving" page.
  const expectedView = withNewTabLinks(Buffer.from(body)).toString();
  const viewed = (served: string) => {
    const away = /href="([^"#]+)\/away#([^"]+)"/.exec(served);
    assert.ok(away, served);
    assert.equal(away[1], config.APP_ORIGIN);
    assert.equal(verifyAwayToken(away[2])?.url, "https://example.org/source");
    return served.replace(away[0], 'href="https://example.org/source"');
  };
  assert.equal(viewed(document.body), expectedView);

  const shared = (
    await call("POST", `/api/artifacts/${receipt.artifactId}/share`, {
      expectedRevisionId: receipt.revisionId,
      expiresInDays: 1,
    })
  ).json().share;
  const token = new URL(shared.url).hash.slice(1);
  const viewer = await grant(token);
  assert.equal(viewer.title, "Saved HTML");
  assert.equal(viewer.revision.htmlProfile, "static");
  const grantedDocument = await app.inject({
    method: "GET",
    url: `/api/view/${viewer.grant}/document`,
  });
  assert.equal(grantedDocument.statusCode, 200);
  assert.equal(viewed(grantedDocument.body), expectedView);
  const report = await call(
    "POST",
    "/api/reports",
    { key: randomUUID(), token, reason: "other", comment: "Проверить" },
    "",
  );
  assert.equal(report.statusCode, 200, report.body);
  assert.equal(
    +(
      await db.query("SELECT count(*) FROM share_reports WHERE share_id=$1", [
        shared.id,
      ])
    ).rows[0].count,
    1,
  );

  const unsupported = Buffer.from(
    "<html><script>document.body.innerHTML = 'runtime';</script></html>",
  );
  const unsupportedBegin = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Runtime HTML",
    filename: "runtime.html",
    mime: "text/html",
    size: unsupported.length,
    sha256: sha256(unsupported),
  });
  const unsupportedId = unsupportedBegin.json().uploadId;
  await call("PUT", `/api/uploads/${unsupportedId}/bytes`, unsupported);
  const unsupportedReceipt = (
    await call("POST", `/api/uploads/${unsupportedId}/finalize`, {})
  ).json();
  assert.equal(unsupportedReceipt.htmlProfile, "unsupported");
  assert.equal(
    (
      await call(
        "POST",
        `/api/artifacts/${unsupportedReceipt.artifactId}/share`,
        {
          expectedRevisionId: unsupportedReceipt.revisionId,
          expiresInDays: 1,
        },
      )
    ).statusCode,
    422,
  );
});
test("Abort and expiry prevent finalize; concurrent finalize returns one receipt", async () => {
  for (const abort of [true, false]) {
    const input = {
      key: randomUUID(),
      title: "pending",
      filename: "a.txt",
      mime: "text/plain",
      size: 1,
      sha256: sha256("a"),
    };
    const u = (await call("POST", "/api/uploads", input)).json();
    if (abort) await call("DELETE", `/api/uploads/${u.uploadId}`);
    else
      await db.query(
        "UPDATE uploads SET expires_at=now()-interval '1 second' WHERE id=$1",
        [u.uploadId],
      );
    assert.equal(
      (await call("POST", `/api/uploads/${u.uploadId}/finalize`, {}))
        .statusCode,
      410,
    );
  }
  const bytes = Buffer.from("race");
  const u = (
    await call("POST", "/api/uploads", {
      key: randomUUID(),
      title: "race",
      filename: "race.txt",
      mime: "text/plain",
      size: bytes.length,
      sha256: sha256(bytes),
    })
  ).json();
  await call("PUT", `/api/uploads/${u.uploadId}/bytes`, bytes);
  const results = await Promise.all([
    call("POST", `/api/uploads/${u.uploadId}/finalize`, {}),
    call("POST", `/api/uploads/${u.uploadId}/finalize`, {}),
  ]);
  assert.equal(results[0].statusCode, 200);
  assert.deepEqual(results[0].json(), results[1].json());
});
test("Share recipient pins v1; saving v2 does not publish; explicit CAS update gives new readers v2", async () => {
  const { receipt: v1 } = await save("first");
  const enabled = await call("POST", `/api/artifacts/${v1.artifactId}/share`, {
    expectedRevisionId: v1.revisionId,
    expiresInDays: 7,
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  const share = enabled.json().share,
    token = new URL(share.url).hash.slice(1);
  const g1 = await grant(token);
  const { receipt: v2 } = await save("second", {
    artifactId: v1.artifactId,
    baseRevisionId: v1.revisionId,
  });
  assert.equal(
    (await call("GET", `/api/artifacts/${v1.artifactId}`)).json().share.status,
    "behind",
  );
  assert.equal((await grant(token)).revision.id, v1.revisionId);
  const change = {
    revisionId: v2.revisionId,
    expectedPublishedRevisionId: v1.revisionId,
  };
  assert.equal(
    (await call("POST", `/api/shares/${share.id}/publish`, change, cb))
      .statusCode,
    404,
  );
  assert.equal(
    (await call("POST", `/api/shares/${share.id}/publish`, change)).statusCode,
    200,
  );
  assert.equal(
    (await call("POST", `/api/shares/${share.id}/publish`, change)).statusCode,
    409,
  );
  assert.equal((await grant(token)).revision.id, v2.revisionId);
  assert.equal((await content(g1.grant)).body, "first");
});
test("Revocation closes resolver and issued grants; a new link never resurrects the old one", async () => {
  const { receipt: r } = await save("revocation");
  const args = { expectedRevisionId: r.revisionId, expiresInDays: 1 };
  const share = (
      await call("POST", `/api/artifacts/${r.artifactId}/share`, args)
    ).json().share,
    token = new URL(share.url).hash.slice(1),
    g = await grant(token);
  assert.equal((await content(g.grant)).statusCode, 200);
  await call("POST", `/api/shares/${share.id}/revoke`, {});
  assert.equal((await content(g.grant)).statusCode, 404);
  assert.equal(
    (await call("POST", "/api/resolve", { token }, "")).statusCode,
    404,
  );
  const newer = (
    await call("POST", `/api/artifacts/${r.artifactId}/share`, args)
  ).json().share;
  assert.notEqual(newer.url, share.url);
  assert.equal(
    (await call("POST", "/api/resolve", { token }, "")).statusCode,
    404,
  );
  assert.equal(
    (
      await call("POST", `/api/shares/${share.id}/publish`, {
        revisionId: r.revisionId,
        expectedPublishedRevisionId: r.revisionId,
      })
    ).statusCode,
    410,
  );
});
test("Expired shares and expired grants deny bytes and disclose no title", async () => {
  const { receipt: r } = await save("expires");
  const s = (
      await call("POST", `/api/artifacts/${r.artifactId}/share`, {
        expectedRevisionId: r.revisionId,
        expiresInDays: 1,
      })
    ).json().share,
    token = new URL(s.url).hash.slice(1);
  const g = await grant(token);
  await db.query(
    "UPDATE grants SET expires_at=now()-interval '1 second' WHERE hash=$1",
    [sha256(g.grant)],
  );
  assert.equal((await content(g.grant)).statusCode, 404);
  const g2 = await grant(token);
  await db.query(
    "UPDATE shares SET expires_at=now()-interval '1 second' WHERE id=$1",
    [s.id],
  );
  assert.equal((await content(g2.grant)).statusCode, 404);
  assert.equal(
    (await call("POST", "/api/resolve", { token }, "")).statusCode,
    404,
  );
});
test("Stale upload cannot overwrite a concurrently saved version", async () => {
  const { receipt: r } = await save("base"),
    body = Buffer.from("stale");
  const u = (
    await call("POST", "/api/uploads", {
      key: randomUUID(),
      title: "stale",
      filename: "a.txt",
      mime: "text/plain",
      size: body.length,
      sha256: sha256(body),
      artifactId: r.artifactId,
      baseRevisionId: r.revisionId,
    })
  ).json();
  await call("PUT", `/api/uploads/${u.uploadId}/bytes`, body);
  const { receipt: next } = await save("winner", {
    artifactId: r.artifactId,
    baseRevisionId: r.revisionId,
  });
  assert.equal(
    (await call("POST", `/api/uploads/${u.uploadId}/finalize`, {})).statusCode,
    409,
  );
  assert.equal(
    (await call("GET", `/api/artifacts/${r.artifactId}`)).json().revision.id,
    next.revisionId,
  );
  await call("DELETE", `/api/uploads/${u.uploadId}`);
});
test("Logout invalidates the server session; mutation origin and noindex headers apply", async () => {
  const login = await call(
      "POST",
      "/api/login",
      { name: b.name, password },
      "",
    ),
    cookie = login.cookies[0].name + "=" + login.cookies[0].value;
  assert.equal(
    (await call("GET", "/api/me", undefined, cookie)).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/folders",
        headers: { cookie, origin: "https://attacker.invalid" },
        payload: { name: "bad" },
      })
    ).statusCode,
    403,
  );
  await call("POST", "/api/logout", {}, cookie);
  assert.equal(
    (await call("GET", "/api/me", undefined, cookie)).statusCode,
    401,
  );
  const noAccess = await call("GET", "/api/artifacts", undefined, "");
  assert.match(noAccess.headers["x-robots-tag"] as string, /noindex/);
  assert.equal(noAccess.headers["cache-control"], "no-store");
  assert.equal(noAccess.headers["referrer-policy"], "no-referrer");
});
test("Quota reservations serialize concurrent requests", async () => {
  await db.query("UPDATE tenants SET quota_bytes=5 WHERE id=$1", [b.tenant]);
  const input = {
    title: "quota",
    filename: "a.txt",
    mime: "text/plain",
    size: 4,
    sha256: sha256("1234"),
  };
  const responses = await Promise.all([
    call("POST", "/api/uploads", { ...input, key: randomUUID() }, cb),
    call("POST", "/api/uploads", { ...input, key: randomUUID() }, cb),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 413]);
});

test("Valid raster upload returns exact bytes; direct anonymous S3 cannot bypass the app", async () => {
  const body = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/JFEAAAAASUVORK5CYII=",
    "base64",
  );
  const started = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Raster fixture",
    filename: "pixel.png",
    mime: "image/png",
    size: body.length,
    sha256: sha256(body),
  });
  const { uploadId } = started.json();
  assert.equal(
    (await call("PUT", `/api/uploads/${uploadId}/bytes`, body)).statusCode,
    200,
  );
  const r = (
    await call("POST", `/api/uploads/${uploadId}/finalize`, {})
  ).json();
  const delivered = await call("GET", `/api/revisions/${r.revisionId}/bytes`);
  assert.deepEqual(delivered.rawPayload, body);
  assert.equal(
    (await fetch(`${config.S3_ENDPOINT}/${bucket}/${a.tenant}/${uploadId}`))
      .status,
    403,
  );
});
test("Shelf is paginated, stable and tenant-scoped; malformed cursor is a client error", async () => {
  for (let i = 0; i < 26; i++)
    await save(`page ${i}`, {
      title: `Pagination ${String(i).padStart(2, "0")}`,
    });
  const first = (await call("GET", "/api/artifacts?q=Pagination")).json();
  assert.equal(first.items.length, 24);
  assert.ok(first.nextCursor);
  const second = (
    await call("GET", `/api/artifacts?q=Pagination&cursor=${first.nextCursor}`)
  ).json();
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((x) => x.id)).size,
    26,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/api/artifacts?q=Pagination&cursor=${first.nextCursor}`,
        undefined,
        cb,
      )
    ).json().items.length,
    0,
  );
  assert.equal(
    (await call("GET", "/api/artifacts?cursor=bad")).statusCode,
    400,
  );
});
test("Recovery after storage-before-DB failure reuses exact bytes; cleanup removes abandoned bytes but preserves receipts", async () => {
  const body = Buffer.from("recover");
  const u = (
    await call("POST", "/api/uploads", {
      key: randomUUID(),
      title: "Recovery",
      filename: "a.txt",
      mime: "text/plain",
      size: body.length,
      sha256: sha256(body),
    })
  ).json();
  await putImmutable(`${a.tenant}/${u.uploadId}`, body); // Simulated interruption before upload metadata commits.
  assert.equal(
    (await call("PUT", `/api/uploads/${u.uploadId}/bytes`, body)).statusCode,
    200,
  );
  const good = (
    await call("POST", `/api/uploads/${u.uploadId}/finalize`, {})
  ).json();
  const lost = (
    await call("POST", "/api/uploads", {
      key: randomUUID(),
      title: "Orphan",
      filename: "a.txt",
      mime: "text/plain",
      size: body.length,
      sha256: sha256(body),
    })
  ).json();
  const version = await putImmutable(`${a.tenant}/${lost.uploadId}`, body);
  await call("DELETE", `/api/uploads/${lost.uploadId}`);
  const cleanup = spawnSync(
    process.execPath,
    ["--import", "tsx", "--env-file=.env", "scripts/maintenance.ts"],
    { encoding: "utf8" },
  );
  assert.equal(cleanup.status, 0, cleanup.stderr);
  await assert.rejects(
    readBlob(`${a.tenant}/${lost.uploadId}`, version),
    (e: any) => e.$metadata.httpStatusCode === 404,
  );
  assert.equal(
    (await call("GET", `/api/revisions/${good.revisionId}/bytes`)).body,
    "recover",
  );
  assert.ok(
    (
      await db.query("SELECT reconciled_at FROM uploads WHERE id=$1", [
        lost.uploadId,
      ])
    ).rows[0].reconciled_at,
  );
});

test("Capabilities state that URL import and HTML runtime are not implemented", async () => {
  const caps = (await call("GET", "/api/capabilities")).json();
  assert.equal(caps.urlImport, false);
  assert.equal(caps.htmlRuntime, false);
  assert.equal(caps.htmlView, "static-sandbox");
  for (const url of ["/api/imports", "/api/import/url", "/api/mcp"])
    assert.equal(
      (await call("POST", url, { url: "https://claude.ai/public/artifacts/x" }))
        .statusCode,
      404,
      url,
    );
});
test("Frontend rebuild serves newly created assets; missing assets never return the HTML shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "polka-static-"));
  const web = await createApp();
  try {
    await mkdir(join(root, "assets"));
    await writeFile(
      join(root, "index.html"),
      "<html><body>Polka shell</body></html>",
    );
    await registerFrontend(web, root);
    await web.ready();
    await writeFile(
      join(root, "assets", "after-start.js"),
      'globalThis.polkaBuild="new";',
    );
    const js = await web.inject("/assets/after-start.js");
    assert.equal(js.statusCode, 200);
    assert.match(js.headers["content-type"] as string, /javascript/);
    assert.ok(js.body.includes("polkaBuild"));
    assert.equal((await web.inject("/assets/missing.js")).statusCode, 404);
    assert.match(
      (await web.inject(`/works/${randomUUID()}`)).body,
      /Polka shell/,
    );
    assert.match(
      (await web.inject("/s")).headers["x-robots-tag"] as string,
      /noindex/,
    );
    for (const route of [
      "/",
      "/bring",
      "/connections",
      "/trash",
      "/discover",
      "/discover/mortgage-calc",
    ])
      assert.match((await web.inject(route)).body, /Polka shell/, route);
  } finally {
    await web.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Email identity: browser binding, one-use code, stable tenant, expiry and attempt limit",
  { skip: config.MAIL_MODE !== "local" },
  async () => {
    const { readFile } = await import("node:fs/promises");
    const email = `signup-${randomUUID()}@example.test`;
    async function challenge() {
      const start = await call("POST", "/api/auth/email/start", { email }, "");
      assert.equal(start.statusCode, 200, start.body);
      assert.equal(start.json().delivery, "local");
      assert.ok(!("code" in start.json()));
      const code = JSON.parse(
        await readFile(`.local/mail/${start.json().id}.json`, "utf8"),
      ).code;
      return {
        id: start.json().id,
        code,
        cookie: `polka_email_challenge=${start.cookies[0].value}`,
      };
    }
    const first = await challenge();
    assert.equal(
      (
        await call(
          "POST",
          "/api/auth/email/verify",
          { id: first.id, code: first.code },
          "",
        )
      ).statusCode,
      401,
    );
    const verified = await call(
      "POST",
      "/api/auth/email/verify",
      { id: first.id, code: first.code },
      first.cookie,
    );
    assert.equal(verified.statusCode, 200, verified.body);
    const session = verified.cookies.find((c) => c.name === "polka_session")!;
    assert.equal(session.httpOnly, true);
    const cookie = `polka_session=${session.value}`;
    const me = await call("GET", "/api/me", undefined, cookie);
    assert.equal(me.statusCode, 200);
    assert.equal(
      (
        await call(
          "POST",
          "/api/auth/email/verify",
          { id: first.id, code: first.code },
          first.cookie,
        )
      ).statusCode,
      401,
    );
    const receipt = await save(
      "First artifact from a new email account",
      {},
      cookie,
    );
    assert.ok(receipt.receipt.artifactId);
    const second = await challenge();
    const again = await call(
      "POST",
      "/api/auth/email/verify",
      { id: second.id, code: second.code },
      second.cookie,
    );
    assert.equal(again.statusCode, 200);
    const againCookie = `polka_session=${again.cookies.find((c) => c.name === "polka_session")!.value}`;
    assert.equal(
      (await call("GET", "/api/me", undefined, againCookie)).json().id,
      me.json().id,
    );
    const {
      rows: [identity],
    } = await db.query(
      "SELECT email_verified_at FROM accounts WHERE email=$1",
      [email],
    );
    assert.equal(
      identity.email_verified_at,
      null,
      "local fixture must not assert email ownership",
    );
    const third = await challenge();
    const wrong = third.code === "11111111" ? "22222222" : "11111111";
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await call(
            "POST",
            "/api/auth/email/verify",
            { id: third.id, code: wrong },
            third.cookie,
          )
        ).statusCode,
        401,
      );
    assert.equal(
      (
        await call(
          "POST",
          "/api/auth/email/verify",
          { id: third.id, code: third.code },
          third.cookie,
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (await call("POST", "/api/auth/email/start", { email }, "")).statusCode,
      429,
    );
    await db.query(
      "UPDATE login_challenges SET attempts=0,expires_at=now()-interval '1 second' WHERE id=$1",
      [third.id],
    );
    assert.equal(
      (
        await call(
          "POST",
          "/api/auth/email/verify",
          { id: third.id, code: third.code },
          third.cookie,
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await call(
          "POST",
          "/api/auth/email/start",
          { email: "real@example.com" },
          "",
        )
      ).statusCode,
      400,
    );
  },
);

test("Agents get plain-text setup instructions at /connect", async () => {
  const guide = await call("GET", "/connect", undefined, "");
  assert.equal(guide.statusCode, 200);
  assert.match(String(guide.headers["content-type"]), /^text\/plain/);
  const mcp = `${config.APP_ORIGIN}/mcp`;
  assert.ok(guide.body.includes(`codex mcp add polka --url ${mcp}`));
  assert.ok(guide.body.includes(`claude mcp add --transport http --scope user polka ${mcp}`));
  // The setup never asks the agent for a token or a password.
  assert.doesNotMatch(guide.body, /Bearer|POLKA_MCP_TOKEN|пароль/i);
});

test(
  "Email identity: new shelves per day are capped for the installation and per IP",
  { skip: config.MAIL_MODE !== "local" },
  async () => {
    const { readFile } = await import("node:fs/promises");
    const mutable = config as { EMAIL_SIGNUP_DAILY_LIMIT: number; EMAIL_SIGNUP_DAILY_PER_IP: number };
    const prior = { day: mutable.EMAIL_SIGNUP_DAILY_LIMIT, ip: mutable.EMAIL_SIGNUP_DAILY_PER_IP };
    const ip = `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
    const post = (url: string, body: unknown, cookie = "") =>
      app.inject({ remoteAddress: ip, method: "POST", url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload: body as object });
    const run = randomUUID().slice(0, 8);
    const signIn = async (email: string) => {
      const start = await post("/api/auth/email/start", { email });
      assert.equal(start.statusCode, 200, start.body);
      const id = start.json().id as string;
      const { code } = JSON.parse(await readFile(`.local/mail/${id}.json`, "utf8"));
      return post("/api/auth/email/verify", { id, code }, `polka_email_challenge=${start.cookies[0].value}`);
    };
    mutable.EMAIL_SIGNUP_DAILY_PER_IP = 1;
    try {
      const first = await signIn(`cap-a-${run}@example.test`);
      assert.equal(first.statusCode, 200, first.body);
      // A second new shelf from the same IP is refused before any code is sent.
      const second = await post("/api/auth/email/start", { email: `cap-b-${run}@example.test` });
      assert.equal(second.statusCode, 429, second.body);
      assert.match(second.json().message, /подключения/);
      // An existing account still signs in from this IP.
      assert.equal((await signIn(`cap-a-${run}@example.test`)).statusCode, 200);
      // A full day for the whole installation refuses new shelves from anywhere.
      mutable.EMAIL_SIGNUP_DAILY_PER_IP = prior.ip;
      mutable.EMAIL_SIGNUP_DAILY_LIMIT = 0;
      const full = await call("POST", "/api/auth/email/start", { email: `cap-c-${run}@example.test` }, "");
      assert.equal(full.statusCode, 429, full.body);
      assert.match(full.json().message, /завтра/);
    } finally {
      mutable.EMAIL_SIGNUP_DAILY_LIMIT = prior.day;
      mutable.EMAIL_SIGNUP_DAILY_PER_IP = prior.ip;
    }
  },
);

test(
  "Email identity: an invite-only installation sends codes only to invited addresses",
  { skip: config.MAIL_MODE !== "local" },
  async () => {
    const { access } = await import("node:fs/promises");
    const mutable = config as { EMAIL_SIGNUP: string; EMAIL_SIGNUP_ALLOW: string[] };
    const prior = { mode: mutable.EMAIL_SIGNUP, allow: mutable.EMAIL_SIGNUP_ALLOW };
    const run = randomUUID().slice(0, 8);
    const team = `team-${run}.test`;
    mutable.EMAIL_SIGNUP = "invite";
    mutable.EMAIL_SIGNUP_ALLOW = [`guest-${run}@example.test`, `@${team}`];
    const mailed = async (email: string) => {
      const start = await call("POST", "/api/auth/email/start", { email }, "");
      // Invited or not, the answer looks the same.
      assert.equal(start.statusCode, 200, start.body);
      const id = start.json().id as string;
      const file = await access(`.local/mail/${id}.json`).then(() => true, () => false);
      const row = (await db.query("SELECT 1 FROM login_challenges WHERE id=$1", [id])).rowCount;
      assert.equal(!!row, file, email);
      return file;
    };
    try {
      assert.equal((await call("GET", "/api/capabilities", undefined, "")).json().emailSignup, "invite");
      assert.equal(await mailed(`stranger-${run}@example.test`), false);
      assert.equal(await mailed(`guest-${run}@example.test`), true);
      assert.equal(await mailed(`anyone@${team}`), true);
      // An existing account keeps signing in without being listed.
      const member = await createAccount(`member-${run}`, password);
      await db.query("UPDATE accounts SET email=$2 WHERE id=$1", [member.id, `member-${run}@example.test`]);
      assert.equal(await mailed(`member-${run}@example.test`), true);
    } finally {
      mutable.EMAIL_SIGNUP = prior.mode;
      mutable.EMAIL_SIGNUP_ALLOW = prior.allow;
    }
  },
);

test(
  "Email identity: a stranger's wrong codes do not lock the owner out",
  { skip: config.MAIL_MODE !== "local" },
  async () => {
    const { readFile } = await import("node:fs/promises");
    const email = `lockout-${randomUUID()}@example.test`;
    const begin = async () => {
      const start = await call("POST", "/api/auth/email/start", { email }, "");
      assert.equal(start.statusCode, 200, start.body);
      const id = start.json().id as string;
      const { code } = JSON.parse(await readFile(`.local/mail/${id}.json`, "utf8"));
      return { id, code: code as string, cookie: `polka_email_challenge=${start.cookies[0].value}` };
    };
    // Someone who knows the address spends every try of their own code.
    const stranger = await begin();
    assert.match(stranger.code, /^\d{8}$/);
    const wrong = stranger.code === "11111111" ? "22222222" : "11111111";
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await call("POST", "/api/auth/email/verify", { id: stranger.id, code: wrong }, stranger.cookie)).statusCode,
        401,
      );
    // Even a full day of such guesses (the old per-address lock stopped at 30)
    // must not refuse the owner.
    const { createHash } = await import("node:crypto");
    await db.query(
      "INSERT INTO login_limits VALUES($1,1000,now()+interval '1 day') ON CONFLICT(key) DO UPDATE SET attempts=1000",
      [createHash("sha256").update(`email-verify-fail:${email}`).digest("hex")],
    );
    // The owner's own code, in the owner's browser, still signs in.
    const owner = await begin();
    const signedIn = await call("POST", "/api/auth/email/verify", { id: owner.id, code: owner.code }, owner.cookie);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    // A six-digit code is not accepted any more.
    assert.equal(
      (await call("POST", "/api/auth/email/verify", { id: owner.id, code: "123456" }, owner.cookie)).statusCode,
      400,
    );
  },
);

test(
  "Email challenge resumes only in bound browser; cleanup removes spent codes and keeps active codes",
  { skip: config.MAIL_MODE !== "local" },
  async () => {
    const { readFile, access } = await import("node:fs/promises");
    const { cleanupEmailChallenges } =
      await import("../apps/server/email-maintenance.ts");
    const start = await call(
      "POST",
      "/api/auth/email/start",
      { email: `resume-${randomUUID()}@example.test` },
      "",
    );
    assert.equal(start.statusCode, 200, start.body);
    const id = start.json().id;
    const cookie = `polka_email_challenge=${start.cookies[0].value}`;
    const resumed = await call(
      "GET",
      "/api/auth/email/current",
      undefined,
      cookie,
    );
    assert.equal(resumed.json().id, id);
    assert.ok(resumed.json().retryAfter > 0);
    assert.ok(!("code" in resumed.json()));
    assert.equal(
      (await call("GET", "/api/auth/email/current", undefined, "")).json(),
      null,
    );
    await cleanupEmailChallenges(1000);
    await access(`.local/mail/${id}.json`);
    const code = JSON.parse(
      await readFile(`.local/mail/${id}.json`, "utf8"),
    ).code;
    assert.equal(
      (await call("POST", "/api/auth/email/verify", { id, code }, cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (await call("GET", "/api/auth/email/current", undefined, cookie)).json(),
      null,
    );
    await cleanupEmailChallenges(1000);
    assert.equal(
      (await db.query("SELECT 1 FROM login_challenges WHERE id=$1", [id]))
        .rowCount,
      0,
    );
    await assert.rejects(access(`.local/mail/${id}.json`), { code: "ENOENT" });
  },
);

test("live experiment disabled refuses owner and recipient issuance for existing HTML", async () => {
  assert.equal(
    config.HTML_LIVE_ENABLED,
    false,
    "Run the default suite with live mode disabled; enabled mode has test:live",
  );
  const saved = await save("<!doctype html><h1>Disabled runtime test</h1>", {
    filename: "disabled.html",
    mime: "text/html",
  });
  const ownerResult = await call(
    "POST",
    `/api/revisions/${saved.receipt.revisionId}/live-view`,
    {},
  );
  assert.equal(ownerResult.statusCode, 404);
  const shared = await call(
    "POST",
    `/api/artifacts/${saved.receipt.artifactId}/share`,
    { expectedRevisionId: saved.receipt.revisionId, expiresInDays: 1 },
  );
  assert.equal(shared.statusCode, 200);
  const resolved = await grant(new URL(shared.json().share.url).hash.slice(1));
  const recipientResult = await app.inject({
    method: "POST",
    url: "/api/view/live-view",
    headers: { origin, authorization: `Bearer ${resolved.grant}` },
  });
  assert.equal(recipientResult.statusCode, 404);
  const capabilities = await app.inject("/api/capabilities");
  assert.equal(capabilities.json().liveExperimental, false);
  assert.equal(capabilities.json().liveMode, "disabled");
  assert.equal(capabilities.json().htmlRuntime, false);
});

test("upload slots go only to signed-in owners, with a cap per shelf and in total", async () => {
  const server = await createApp();
  await server.listen({ host: "127.0.0.1", port: 0 });
  const { port } = server.server.address() as import("node:net").AddressInfo;
  const held: import("node:http").ClientRequest[] = [];
  const request = (cookie: string, hold: boolean) =>
    new Promise<number>((resolve, reject) => {
      const bytes = Buffer.from("slot");
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "PUT",
          path: `/api/uploads/${randomUUID()}/bytes`,
          headers: {
            origin,
            "content-type": "application/octet-stream",
            // A held request announces more bytes than it sends, so it keeps
            // its slot until it is destroyed.
            "content-length": String(hold ? 1024 : bytes.length),
            ...(cookie ? { cookie } : {}),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", (error) => (hold ? undefined : reject(error)));
      req.write(bytes);
      if (hold) held.push(req);
      else req.end();
    });
  // A probe's slot is released when its response closes, which can trail the
  // client seeing it; a held request refused in that moment simply retries.
  const hold = (cookie: string): Promise<number> =>
    request(cookie, true).then((status) =>
      status === 429 ? hold(cookie) : status,
    );
  // A finished probe releases its slot; 429 means the cap is full.
  const refusedSoon = async (cookie: string, expected: boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (((await request(cookie, false)) === 429) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`probe was ${expected ? "never" : "still"} refused`);
  };
  const login = async (name: string) => {
    const response = await call("POST", "/api/login", { name, password }, "");
    assert.equal(response.statusCode, 200);
    return `${response.cookies[0].name}=${response.cookies[0].value}`;
  };
  const third = await createAccount(
    `test-c-${randomBytes(5).toString("hex")}`,
    password,
  );
  const cc = await login(third.name);
  try {
    // Anonymous requests are refused before a slot is taken.
    for (let index = 0; index < 6; index++)
      assert.equal(await request("", false), 401);
    for (let slot = 0; slot < TRANSFER_SLOTS.perTenant; slot++) void hold(ca);
    await refusedSoon(ca, true);
    // Another shelf still gets the remaining slot.
    await refusedSoon(cb, false);
    for (
      let slot = TRANSFER_SLOTS.perTenant;
      slot < TRANSFER_SLOTS.total;
      slot++
    )
      void hold(cb);
    await refusedSoon(cc, true);
    assert.equal(await request("", false), 401);
    for (const req of held.splice(0)) req.destroy();
    await refusedSoon(ca, false);
    await refusedSoon(cc, false);
  } finally {
    for (const req of held) req.destroy();
    await server.close();
  }
});

test("share resolution is rate limited per address", async () => {
  const ip = `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
  const resolve = () =>
    app.inject({
      method: "POST",
      url: "/api/resolve",
      remoteAddress: ip,
      headers: { origin },
      payload: { token: randomBytes(32).toString("base64url") },
    });
  assert.equal((await resolve()).statusCode, 404);
  await db.query("UPDATE login_limits SET attempts=$2 WHERE key=$1", [
    sha256(`resolve:ip:${ip}`),
    RESOLVE_LIMIT_PER_IP,
  ]);
  const limited = await resolve();
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "quota");
});
