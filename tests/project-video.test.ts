// Video in a project (docs/specs/PROJECT_VIDEO.md): a video of tens of
// megabytes is streamed into the store while it arrives, checked against its
// manifest entry, played back in ranges as a player seeks, and copied by
// reference into the next version. Only a shelf with video enabled may save
// one; a bad file leaves nothing in the store.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { bucket, s3, sha256 } from "../apps/server/storage.ts";
import { parseRange } from "../apps/server/project-viewer.ts";
import { bundleManifestSchema } from "../packages/contracts/bundle.ts";

if (!config.HTML_LIVE_ENABLED)
  throw new Error("Run project-video.test.ts with HTML_LIVE_ENABLED=true");

const app = await createApp();
const viewer = await createLiveViewerApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";
let secret = "";
const auth = () => ({ authorization: `Bearer ${secret}` });

/** A file that starts like an MP4 (a `ftyp` box) and is `size` bytes long. */
const fakeMp4 = (size: number) => {
  const bytes = randomBytes(size);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftypisom", 4, "latin1");
  return bytes;
};
const CLIP = fakeMp4(19 * 1024 * 1024 + 12345); // three 8 MiB parts
const README = Buffer.from("# Игра\n\nВидео: `intro.mp4`\n");
const hashOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const manifestOf = (files: Array<{ path: string; mime: string; bytes: Buffer }>) => ({
  version: 1,
  entrypoint: "README.md",
  runtime: "project-v1",
  files: files.map((f) => ({ path: f.path, mime: f.mime, size: f.bytes.length, sha256: hashOf(f.bytes) })),
  provenance: { kind: "file", sourceUrl: null, capturedAt: new Date().toISOString(), attribution: "unknown", license: "unknown" },
  dependencies: { status: "unknown", unresolved: [] },
});
const project = (clip = CLIP) => [
  { path: "README.md", mime: "text/markdown", bytes: README },
  { path: "intro.mp4", mime: "video/mp4", bytes: clip },
];

async function begin(files = project(), extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { ...auth(), "content-type": "application/json" },
    payload: JSON.stringify({ key: randomUUID(), title: "Игра с видео", manifest: manifestOf(files), ...extra }),
  });
}
const putFile = (uploadId: string, index: number, bytes: Buffer) =>
  app.inject({
    method: "PUT",
    url: `/api/v1/projects/${uploadId}/files/${index}`,
    headers: { ...auth(), "content-type": "application/octet-stream" },
    payload: bytes,
  });
const putMedia = (uploadId: string, index: number, bytes: Buffer) =>
  app.inject({
    method: "PUT",
    url: `/api/v1/projects/${uploadId}/media/${index}`,
    headers: { ...auth(), "content-type": "application/octet-stream" },
    payload: bytes,
  });
const finalize = (uploadId: string) =>
  app.inject({
    method: "POST",
    url: `/api/v1/projects/${uploadId}/finalize`,
    headers: { ...auth(), "content-type": "application/json" },
    payload: "{}",
  });
const versionsOf = async (prefix: string) =>
  (await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }))).Versions ?? [];

/** Saves the project and returns the receipt. */
async function save(files = project(), extra: Record<string, unknown> = {}) {
  const begun = await begin(files, extra);
  assert.equal(begun.statusCode, 200, begun.body);
  for (const { index, path } of begun.json().files) {
    const file = files.find((f) => f.path === path)!;
    const put = file.mime.startsWith("video/")
      ? await putMedia(begun.json().uploadId, index, file.bytes)
      : await putFile(begun.json().uploadId, index, file.bytes);
    assert.equal(put.statusCode, 200, put.body);
  }
  const done = await finalize(begun.json().uploadId);
  assert.equal(done.statusCode, 200, done.body);
  return done.json() as { artifactId: string; revisionId: string };
}

const view = (url: string, headers: Record<string, string> = {}, dest = "video", mode = "no-cors") =>
  viewer.inject({
    method: "GET",
    url: new URL(url).pathname,
    headers: { host: config.VIEWER_UPSTREAM_HOST, "sec-fetch-dest": dest, "sec-fetch-mode": mode, ...headers },
  });

async function issue(revisionId: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/revisions/${revisionId}/project-view`,
    headers: { origin, cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().url as string;
}

before(async () => {
  owner = await createAccount(`video-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({ method: "POST", url: "/api/login", headers: { origin }, payload: { name: owner.name, password } });
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'video',$5,$6,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(secret), ["capture", "revise", "source:read"], MCP_AUDIENCE],
  );
});

after(async () => {
  await Promise.allSettled([app.close(), viewer.close()]);
  await db.end();
  s3.destroy();
});

test("a byte range is read as a player asks for it", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=990-5000", 1000), { start: 990, end: 999 });
  assert.equal(parseRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=5-2", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
  // Not one range: the whole file is sent.
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange("bytes=0-1,5-9", 1000), null);
  assert.equal(parseRange("items=0-1", 1000), null);
});

test("the manifest takes video only in a project, in its own size class", () => {
  const clip = (size: number, mime = "video/mp4") => ({ path: "a.mp4", mime, size, sha256: "a".repeat(64) });
  const doc = { path: "README.md", mime: "text/markdown", size: 5, sha256: "b".repeat(64) };
  const manifest = (files: unknown[], runtime = "project-v1") => ({
    ...manifestOf(project()),
    runtime,
    files,
  });
  assert.doesNotThrow(() => bundleManifestSchema.parse(manifest([doc, clip(200 * 1024 * 1024)])));
  assert.throws(() => bundleManifestSchema.parse(manifest([doc, clip(200 * 1024 * 1024 + 1)])));
  assert.throws(() => bundleManifestSchema.parse(manifest([doc, clip(1, "video/quicktime")])));
  // Not a project: no video, and the usual 5 MiB.
  assert.throws(() => bundleManifestSchema.parse(manifest([{ ...doc, mime: "text/html" }, clip(10)], "preserved-only-v1")));
  // Together, videos are bounded.
  const two = [doc, clip(200 * 1024 * 1024), { ...clip(200 * 1024 * 1024), path: "b.mp4" }, { ...clip(1), path: "c.mp4" }];
  assert.throws(() => bundleManifestSchema.parse(manifest(two)));
  // Other files keep 5 MiB.
  assert.throws(() => bundleManifestSchema.parse(manifest([{ ...doc, size: 6 * 1024 * 1024 }])));
});

test("a shelf without video refuses it, and a shelf with it is bound by its space", async () => {
  const refused = await begin();
  assert.equal(refused.statusCode, 403, refused.body);
  assert.match(refused.json().message, /Видео/);
  await db.query("UPDATE tenants SET video_enabled=true, quota_bytes=1000 WHERE id=$1", [owner.tenant]);
  const full = await begin();
  assert.equal(full.statusCode, 413, full.body);
  await db.query("UPDATE tenants SET quota_bytes=DEFAULT WHERE id=$1", [owner.tenant]);
});

test("a video that is not the file the manifest names leaves nothing in the store", async () => {
  const begun = await begin();
  assert.equal(begun.statusCode, 200, begun.body);
  const { uploadId } = begun.json();
  const index = begun.json().files.find((f: { path: string }) => f.path === "intro.mp4").index;
  const prefix = `${owner.tenant}/${uploadId}/files/${index}`;
  // Cut off, longer, changed, and not a video at all.
  assert.equal((await putMedia(uploadId, index, CLIP.subarray(0, CLIP.length - 1))).statusCode, 422);
  assert.equal((await putMedia(uploadId, index, Buffer.concat([CLIP, Buffer.from("x")]))).statusCode, 422);
  const changed = Buffer.from(CLIP);
  changed[changed.length - 5] ^= 0xff;
  assert.equal((await putMedia(uploadId, index, changed)).statusCode, 422);
  const wrongKind = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { ...auth(), "content-type": "application/json" },
    payload: JSON.stringify({ key: randomUUID(), title: "Не видео", manifest: manifestOf(project(randomBytes(4096))) }),
  });
  const notVideo = await putMedia(wrongKind.json().uploadId, 1, randomBytes(4096));
  assert.equal(notVideo.statusCode, 422);
  assert.match(notVideo.json().message, /MP4/);
  assert.equal((await versionsOf(prefix)).length, 0);
  // A page is not sent as a stream.
  assert.equal((await putMedia(uploadId, 0, README)).statusCode, 415);
  // Without the connection's token nothing is read.
  const anonymous = await app.inject({ method: "PUT", url: `/api/v1/projects/${uploadId}/media/${index}`, headers: { "content-type": "application/octet-stream" }, payload: CLIP });
  assert.equal(anonymous.statusCode, 401);
  // A refusal ends the connection rather than reading on through a 200 MB body.
  assert.equal(anonymous.headers.connection, "close");
  // A finalize with the video missing says so.
  assert.equal((await putFile(uploadId, 0, README)).statusCode, 200);
  assert.equal((await finalize(uploadId)).statusCode, 409);
});

test("a project with a video is saved, counted, played in ranges and taken down again", async () => {
  const before = Number((await db.query("SELECT used_bytes FROM tenants WHERE id=$1", [owner.tenant])).rows[0].used_bytes);
  const saved = await save();
  const { rows: [revision] } = await db.query("SELECT total_size FROM revisions WHERE id=$1", [saved.revisionId]);
  assert.equal(Number(revision.total_size), README.length + CLIP.length);
  const after = Number((await db.query("SELECT used_bytes FROM tenants WHERE id=$1", [owner.tenant])).rows[0].used_bytes);
  assert.equal(after - before, README.length + CLIP.length);
  const { rows: [file] } = await db.query("SELECT object_key,object_version,size FROM revision_files WHERE revision_id=$1 AND path='intro.mp4'", [saved.revisionId]);
  assert.equal(Number(file.size), CLIP.length);

  const url = await issue(saved.revisionId);
  // The whole file, then a range like a player's first request, a seek and the tail.
  const whole = await view(url + "intro.mp4");
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers["content-type"], "video/mp4");
  assert.equal(whole.headers["accept-ranges"], "bytes");
  assert.equal(Number(whole.headers["content-length"]), CLIP.length);
  assert.ok(whole.rawPayload.equals(CLIP));
  const first = await view(url + "intro.mp4", { range: "bytes=0-1" });
  assert.equal(first.statusCode, 206);
  assert.equal(first.headers["content-range"], `bytes 0-1/${CLIP.length}`);
  // <audio> plays an MP4 with sound only, and a script may fetch it in ranges.
  const asAudio = await view(url + "intro.mp4", { range: "bytes=10-19" }, "audio");
  assert.equal(asAudio.statusCode, 206);
  assert.ok(asAudio.rawPayload.equals(CLIP.subarray(10, 20)));
  assert.equal(asAudio.headers["access-control-allow-origin"], "*");
  assert.equal((await view(url + "intro.mp4", { range: "bytes=0-9" }, "empty", "cors")).statusCode, 206);
  assert.ok(first.rawPayload.equals(CLIP.subarray(0, 2)));
  const seek = await view(url + "intro.mp4", { range: `bytes=${9 * 1024 * 1024}-${9 * 1024 * 1024 + 4095}` });
  assert.equal(seek.statusCode, 206);
  assert.ok(seek.rawPayload.equals(CLIP.subarray(9 * 1024 * 1024, 9 * 1024 * 1024 + 4096)));
  const tail = await view(url + "intro.mp4", { range: "bytes=-100" });
  assert.equal(tail.headers["content-range"], `bytes ${CLIP.length - 100}-${CLIP.length - 1}/${CLIP.length}`);
  assert.ok(tail.rawPayload.equals(CLIP.subarray(CLIP.length - 100)));
  const beyond = await view(url + "intro.mp4", { range: `bytes=${CLIP.length}-` });
  assert.equal(beyond.statusCode, 416);
  assert.equal(beyond.headers["content-range"], `bytes */${CLIP.length}`);
  // A page cannot pull it as a script or a picture, and it is not a page.
  assert.equal((await view(url + "intro.mp4", {}, "script")).statusCode, 404);
  assert.equal((await view(url + "intro.mp4", {}, "image")).statusCode, 404);
  assert.equal((await view(url + "intro.mp4", {}, "document", "navigate")).statusCode, 404);
  // Opened from the project tree it is a player page that may load only this project's media.
  const page = await view(url + "intro.mp4", {}, "iframe", "navigate");
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<video controls preload="metadata"[^>]*src="intro\.mp4"/);
  assert.match(String(page.headers["content-security-policy"]), new RegExp(`media-src ${url}`));

  // polka pull streams it with its size and hash; the JSON source refuses it.
  const listing = await app.inject({ method: "GET", url: `/api/v1/works/${saved.artifactId}/files`, headers: auth() });
  assert.equal(listing.statusCode, 200, listing.body);
  const at = listing.json().files.find((f: { path: string }) => f.path === "intro.mp4");
  const pulled = await app.inject({
    method: "GET",
    url: `/api/v1/works/${saved.artifactId}/revisions/${saved.revisionId}/files/${at.index}`,
    headers: auth(),
  });
  assert.equal(pulled.statusCode, 200);
  assert.equal(pulled.headers["x-polka-sha256"], hashOf(CLIP));
  assert.ok(pulled.rawPayload.equals(CLIP));
  const source = await app.inject({ method: "GET", url: `/api/revisions/${saved.revisionId}/export`, headers: { origin, cookie } });
  assert.equal(source.statusCode, 422, source.body);

  // A new version keeps the video by reference: it is copied in the store, not sent.
  const next = project();
  next[0] = { ...next[0]!, bytes: Buffer.from("# Игра\n\nНовая версия.\n") };
  const begun = await begin(next, { artifactId: saved.artifactId, baseRevisionId: saved.revisionId });
  assert.equal(begun.statusCode, 200, begun.body);
  const reuse = await app.inject({ method: "POST", url: `/api/v1/projects/${begun.json().uploadId}/reuse`, headers: { ...auth(), "content-type": "application/json" }, payload: "{}" });
  assert.deepEqual(reuse.json().reused, [1]);
  assert.equal((await putFile(begun.json().uploadId, 0, next[0]!.bytes)).statusCode, 200);
  const done = await finalize(begun.json().uploadId);
  assert.equal(done.statusCode, 200, done.body);
  const second = await view(await issue(done.json().revisionId) + "intro.mp4", { range: "bytes=100-199" });
  assert.equal(second.statusCode, 206);
  assert.ok(second.rawPayload.equals(CLIP.subarray(100, 200)));

  // The view ends with the trash: no bytes after it.
  await db.query("UPDATE artifacts SET trashed_at=now() WHERE id=$1", [saved.artifactId]);
  try {
    assert.equal((await view(url + "intro.mp4")).statusCode, 404);
  } finally {
    await db.query("UPDATE artifacts SET trashed_at=NULL WHERE id=$1", [saved.artifactId]);
  }
});

test("sending the same video again is safe, and a small video may come as a plain file", async () => {
  const begun = await begin();
  const { uploadId } = begun.json();
  assert.equal((await putMedia(uploadId, 1, CLIP)).statusCode, 200);
  assert.equal((await putMedia(uploadId, 1, CLIP)).statusCode, 200);
  assert.equal((await putFile(uploadId, 0, README)).statusCode, 200);
  assert.equal((await finalize(uploadId)).statusCode, 200);
  assert.equal((await finalize(uploadId)).statusCode, 200);
  assert.equal((await versionsOf(`${owner.tenant}/${uploadId}/files/1`)).length, 1);
  const tiny = fakeMp4(4096);
  const saved = await save(project(tiny));
  const { rows: [file] } = await db.query("SELECT size FROM revision_files WHERE revision_id=$1 AND path='intro.mp4'", [saved.revisionId]);
  assert.equal(Number(file.size), 4096);
});

test("the command-line tools send a video as a stream and bring it back to disk", async () => {
  const publish = fileURLToPath(new URL("../scripts/polka-publish-project.mjs", import.meta.url));
  const pull = fileURLToPath(new URL("../scripts/polka-pull.mjs", import.meta.url));
  const node = (script: string, args: string[], env: Record<string, string>) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
      let out = "", err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    });
  // The saves above filled the default 100 MiB; a shelf with video has more.
  await db.query("UPDATE tenants SET quota_bytes=1073741824 WHERE id=$1", [owner.tenant]);
  const scratch = await mkdtemp(join(tmpdir(), "polka-video-"));
  const game = join(scratch, "game");
  await mkdir(game, { recursive: true });
  const clip = fakeMp4(21 * 1024 * 1024);
  await writeFile(join(game, "index.html"), '<!doctype html><title>Игра</title><video src="intro.mp4" controls></video>');
  await writeFile(join(game, "intro.mp4"), clip);
  await writeFile(join(game, "too-big.mp4"), Buffer.alloc(0));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const env = {
      POLKA_TOKEN: secret,
      POLKA_ENDPOINT: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    };
    const dry = await node(publish, [game, "--dry-run"], {});
    assert.equal(dry.code, 0, dry.err);
    assert.deepEqual(JSON.parse(dry.out).paths, ["index.html", "intro.mp4"]);
    const pushed = await node(publish, [game, "--json"], env);
    assert.equal(pushed.code, 0, pushed.err);
    const saved = JSON.parse(pushed.out);
    assert.equal(saved.megabytes, 21);
    assert.deepEqual(saved.skipped.map((item: { path: string }) => item.path), ["too-big.mp4"]);
    const back = join(scratch, "back");
    const pulled = await node(pull, [saved.artifactId, back, "--json"], env);
    assert.equal(pulled.code, 0, pulled.err);
    assert.ok((await readFile(join(back, "intro.mp4"))).equals(clip));
    // The next version from that folder sends the changed page only.
    await writeFile(join(back, "index.html"), '<!doctype html><title>Игра 2</title><video src="intro.mp4" controls></video>');
    const next = await node(publish, [back, "--json"], env);
    assert.equal(next.code, 0, next.err);
    assert.equal(JSON.parse(next.out).unchanged, 1);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
