import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFrontend } from "../apps/server/frontend.ts";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createApp } from "../apps/server/app.ts";
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
async function call(method: any, url: string, body?: any, cookie = ca) {
  return app.inject({
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
  assert.equal(
    (
      await call("POST", "/api/uploads", {
        key: randomUUID(),
        title: "HTML",
        filename: "a.html",
        mime: "text/html",
        size: 1,
        sha256: sha256("a"),
      })
    ).statusCode,
    400,
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
  } finally {
    await web.close();
    await rm(root, { recursive: true, force: true });
  }
});
