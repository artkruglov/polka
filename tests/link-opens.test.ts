// How often a link was opened, for its author (docs/specs/LINK_OPENS.md): a
// count per day of recipients' opens, not the owner's own, and no reader named.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";

const call = (method: any, url: string, body?: unknown, withCookie = true) =>
  app.inject({ method, url, headers: { origin, ...(withCookie ? { cookie } : {}) }, payload: body as any });

before(async () => {
  owner = await createAccount(`opens-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: owner.name, password },
  });
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
});
after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

async function sharedWork() {
  const bytes = Buffer.from(`<!doctype html><title>Открытия</title><p>${randomUUID()}</p>`);
  const begun = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Открытия",
    filename: "index.html",
    mime: "text/html",
    size: bytes.length,
    sha256: sha256(bytes),
  });
  const uploadId = begun.json().uploadId as string;
  await app.inject({
    method: "PUT",
    url: `/api/uploads/${uploadId}/bytes`,
    headers: { origin, cookie, "content-type": "application/octet-stream" },
    payload: bytes,
  });
  const done = (await call("POST", `/api/uploads/${uploadId}/finalize`, {})).json();
  const shared = await call("POST", `/api/artifacts/${done.artifactId}/share`, {
    expectedRevisionId: done.revisionId,
    expiresInDays: 7,
  });
  assert.equal(shared.statusCode, 200, shared.body);
  return { artifactId: done.artifactId as string, token: new URL(shared.json().share.url).hash.slice(1) };
}
const resolve = (token: string, withCookie: boolean) => call("POST", "/api/resolve", { token }, withCookie);
const opens = async (artifactId: string) => (await call("GET", `/api/artifacts/${artifactId}`)).json().share.opens;

test("the author sees how often recipients opened the link, and when last", async () => {
  const work = await sharedWork();
  assert.deepEqual(await opens(work.artifactId), { total: 0, days: 0, lastOpenedAt: null });
  assert.equal((await resolve(work.token, false)).statusCode, 200);
  assert.equal((await resolve(work.token, false)).statusCode, 200);
  assert.equal((await resolve(work.token, false)).statusCode, 200);
  const seen = await opens(work.artifactId);
  assert.equal(seen.total, 3);
  assert.equal(seen.days, 1);
  assert.ok(Date.now() - new Date(seen.lastOpenedAt).getTime() < 60_000);
  // The row holds a number and a time, nothing that names a reader.
  const { rows } = await db.query(
    "SELECT * FROM share_open_days WHERE share_id IN (SELECT id FROM shares WHERE artifact_id=$1)",
    [work.artifactId],
  );
  assert.deepEqual(Object.keys(rows[0]).sort(), ["day", "last_opened_at", "opens", "share_id"]);
});

test("the owner opening their own link is not counted", async () => {
  const work = await sharedWork();
  assert.equal((await resolve(work.token, true)).statusCode, 200);
  assert.equal((await opens(work.artifactId)).total, 0);
  assert.equal((await resolve(work.token, false)).statusCode, 200);
  assert.equal((await opens(work.artifactId)).total, 1);
});

test("a revoked link is not opened and not counted; the count goes with the link", async () => {
  const work = await sharedWork();
  assert.equal((await resolve(work.token, false)).statusCode, 200);
  const share = (await call("GET", `/api/artifacts/${work.artifactId}`)).json().share;
  assert.equal((await call("POST", `/api/shares/${share.id}/revoke`, {})).statusCode, 200);
  assert.notEqual((await resolve(work.token, false)).statusCode, 200);
  assert.equal((await opens(work.artifactId)).total, 1);
  await db.query("DELETE FROM grants WHERE share_id=$1", [share.id]);
  await db.query("DELETE FROM viewer_grants WHERE share_id=$1", [share.id]);
  await db.query("DELETE FROM shares WHERE id=$1", [share.id]);
  const { rowCount } = await db.query("SELECT 1 FROM share_open_days WHERE share_id=$1", [share.id]);
  assert.equal(rowCount, 0);
});
