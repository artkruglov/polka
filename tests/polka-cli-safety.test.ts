// polka-pull.mjs and polka-publish-project.mjs against a stub server that may
// be hostile: what a manifest may write, links on disk, a .polka.json that
// anyone could have put in the folder, and where the token is allowed to go.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const pull = fileURLToPath(new URL("../scripts/polka-pull.mjs", import.meta.url));
const publish = fileURLToPath(new URL("../scripts/polka-publish-project.mjs", import.meta.url));
const ARTIFACT = "11111111-1111-4111-8111-111111111111";
const REVISION = "22222222-2222-4222-8222-222222222222";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let scratch: string;
let server: Server;
let origin: string;
let requests: string[] = [];
let listing: Array<{ path: string; bytes: Buffer }> = [];
let damaged = false;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "polka-cli-"));
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url!, "http://x");
    if (url.pathname === `/api/v1/works/${ARTIFACT}/files`) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          artifactId: ARTIFACT,
          title: "Проект",
          revisionId: REVISION,
          number: 1,
          latestRevisionId: REVISION,
          runtime: "project-v1",
          entrypoint: "index.html",
          files: listing.map((file, index) => ({
            index,
            path: file.path,
            mime: "text/plain",
            size: file.bytes.length,
            sha256: sha(file.bytes),
          })),
        }),
      );
      return;
    }
    const file = /\/files\/(\d+)$/.exec(url.pathname);
    if (file && listing[Number(file[1])]) {
      const bytes = listing[Number(file[1])].bytes;
      res.end(damaged ? Buffer.concat([bytes, Buffer.from("x")]) : bytes);
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
});

const node = (script: string, args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH ?? "", POLKA_TOKEN: "secret-token", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });

const reset = (files: Array<{ path: string; bytes: Buffer }>) => {
  listing = files;
  requests = [];
  damaged = false;
};
const text = (path: string, body = path) => ({ path, bytes: Buffer.from(body) });
const exists = (path: string) => lstat(path).then(() => true, () => false);

test("pull writes a version, and lists a local file it replaced", async () => {
  reset([text("index.html", "new"), text("docs/a.md")]);
  const folder = join(scratch, "ok");
  await mkdir(folder);
  await writeFile(join(folder, "index.html"), "my edit");
  const forced = await node(pull, [ARTIFACT, folder, "--force", "--json"], { POLKA_ENDPOINT: origin });
  assert.equal(forced.code, 0, forced.err);
  assert.deepEqual(JSON.parse(forced.out).overwritten, ["index.html"]);
  assert.equal(await readFile(join(folder, "docs/a.md"), "utf8"), "docs/a.md");
  assert.equal(JSON.parse(await readFile(join(folder, ".polka.json"), "utf8")).revisionId, REVISION);
});

test("pull refuses a manifest path that leaves the folder or starts with a dot", async () => {
  for (const path of ["../escape.txt", "a/../../escape.txt", "/etc/escape.txt", ".git/hooks/post-checkout", ".polka.json", "a//b.txt", "a\\b.txt"]) {
    reset([text(path)]);
    const folder = join(scratch, `bad-${Math.random().toString(36).slice(2)}`);
    const result = await node(pull, [ARTIFACT, folder], { POLKA_ENDPOINT: origin });
    assert.notEqual(result.code, 0, path);
    assert.match(result.err, /Unsafe path/, path);
    assert.equal(await exists(join(folder, ".git")), false, path);
    assert.equal(await exists(join(scratch, "escape.txt")), false, path);
  }
});

test("pull does not write through a link, with --force either", async () => {
  const outside = join(scratch, "outside");
  await mkdir(outside);
  reset([text("docs/authorized_keys", "attacker")]);
  const folder = join(scratch, "linked");
  await mkdir(folder);
  await symlink(outside, join(folder, "docs"));
  const dirLink = await node(pull, [ARTIFACT, folder, "--force"], { POLKA_ENDPOINT: origin });
  assert.notEqual(dirLink.code, 0);
  assert.match(dirLink.err, /is a link/);
  assert.equal(await exists(join(outside, "authorized_keys")), false);

  // A link in the place of the file itself is refused too, and its target is untouched.
  await rm(join(folder, "docs"));
  await mkdir(join(folder, "docs"));
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "keep");
  await symlink(secret, join(folder, "docs/authorized_keys"));
  const fileLink = await node(pull, [ARTIFACT, folder, "--force"], { POLKA_ENDPOINT: origin });
  assert.notEqual(fileLink.code, 0);
  assert.equal(await readFile(secret, "utf8"), "keep");
  assert.equal(await readlink(join(folder, "docs/authorized_keys")), secret);
});

test("pull refuses a damaged file and a plain-http endpoint", async () => {
  reset([text("a.txt")]);
  damaged = true;
  const damagedRun = await node(pull, [ARTIFACT, join(scratch, "damaged")], { POLKA_ENDPOINT: origin });
  assert.notEqual(damagedRun.code, 0);
  assert.match(damagedRun.err, /arrived damaged/);

  reset([text("a.txt")]);
  const remote = await node(pull, [ARTIFACT, join(scratch, "http")], { POLKA_ENDPOINT: "http://polka.example.com" });
  assert.equal(remote.code, 2);
  assert.match(remote.err, /must use https/);
  assert.deepEqual(requests, []);
});

const state = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    endpoint: origin,
    artifactId: ARTIFACT,
    revisionId: REVISION,
    title: "Проект",
    runtime: "project-v1",
    ...extra,
  });

async function folderWith(name: string, json: string) {
  const folder = join(scratch, name);
  await mkdir(folder);
  await writeFile(join(folder, "index.html"), "<p>hi</p>");
  await writeFile(join(folder, ".polka.json"), json);
  return folder;
}

test("publish: the address in .polka.json never receives the token", async () => {
  reset([]);
  const folder = await folderWith("trust", state());
  // No configured address: the file is not one.
  const none = await node(publish, [folder]);
  assert.equal(none.code, 2);
  assert.match(none.err, /Pass --endpoint or set POLKA_ENDPOINT/);
  // A configured address that is not the folder's is a refusal, before any request.
  const other = await node(publish, [folder], { POLKA_ENDPOINT: "http://127.0.0.1:9" });
  assert.equal(other.code, 2);
  assert.match(other.err, /was pulled from/);
  assert.deepEqual(requests, []);
});

test("publish: a trailing slash or letter case is not another address", async () => {
  reset([]);
  const folder = await folderWith("origin", state({ endpoint: `${origin.toUpperCase()}/` }));
  const result = await node(publish, [folder], { POLKA_ENDPOINT: origin });
  assert.doesNotMatch(result.err, /was pulled from/);
});

test("publish: a malformed .polka.json is ignored, and its title cannot carry escape codes", async () => {
  reset([]);
  const junk = await folderWith("junk", state({ artifactId: "not-a-uuid" }));
  const dry = await node(publish, [junk, "--dry-run"], { POLKA_ENDPOINT: origin });
  assert.equal(dry.code, 0, dry.err);
  assert.doesNotMatch(dry.out, /artifactId/);

  const folder = await folderWith("escape", state({ runtime: "component", title: "x\u001b[31mRED\u001b[0m" }));
  const refused = await node(publish, [folder], { POLKA_ENDPOINT: origin });
  assert.equal(refused.code, 2);
  assert.doesNotMatch(refused.err, /\u001b/);
});

test("publish: a plain-http endpoint is refused", async () => {
  const folder = await folderWith("http", state({ endpoint: "http://polka.example.com" }));
  const result = await node(publish, [folder], { POLKA_ENDPOINT: "http://polka.example.com" });
  assert.equal(result.code, 2);
  assert.match(result.err, /must use https/);
});
