import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { AgentScope } from "../packages/contracts/index.ts";
import { MAX_BYTES } from "../packages/contracts/index.ts";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { PUBLISH_API_LIMITS } from "../apps/server/publish-api.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

// The default suite runs static-only, like the hosted pilot today.
const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const cliPath = fileURLToPath(
  new URL("../scripts/polka-publish.mjs", import.meta.url),
);
const address = () =>
  `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

type Owner = { id: string; tenant: string; name: string };
let owner: Owner;
let scratch: string;

async function newOwner(prefix: string): Promise<Owner> {
  return createAccount(`${prefix}-${randomBytes(5).toString("hex")}`, password);
}

async function token(
  who: Owner,
  scopes: AgentScope[] = ["context", "capture", "share"],
) {
  const id = randomUUID(),
    secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'http api',$5,$6,now()+interval '1 day')`,
    [id, who.tenant, who.id, sha256(secret), scopes, MCP_AUDIENCE],
  );
  return { id, secret };
}

const page = (heading: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title><style>body{font-family:system-ui;margin:40px}</style></head><body><h1>${heading}</h1><p>A self-contained report produced by a company agent for the account owner.</p></body></html>`;

function publish(
  body: unknown,
  headers: Record<string, string> = {},
  remoteAddress = address(),
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress,
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

before(async () => {
  owner = await newOwner("publish-api");
  scratch = await mkdtemp(join(tmpdir(), "polka-publish-cli-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
  await app.close();
  await db.end();
  s3.destroy();
});

test("publishes without an Origin header and returns the link", async () => {
  const { secret } = await token(owner);
  const response = await publish(
    {
      key: randomUUID(),
      title: "Quarterly",
      html: page("Quarterly"),
      expiresInDays: 7,
    },
    bearer(secret),
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.cookies.length, 0);
  assert.equal(response.headers["cache-control"], "no-store");
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "artifactId",
    "expiresAt",
    "interactiveReady",
    "revisionId",
    "scriptsRunForRecipients",
    "shelfUrl",
    "state",
    "url",
  ]);
  assert.equal(body.state, "shared");
  assert.match(body.url, new RegExp(`^${origin}/s#[A-Za-z0-9_-]{43}$`));
  assert.equal(body.shelfUrl, `${origin}/works/${body.artifactId}`);
  assert.equal(body.interactiveReady, false);
  const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7, String(days));
  const shared = await app.inject({
    method: "POST",
    url: "/api/resolve",
    remoteAddress: address(),
    headers: { origin },
    payload: { token: new URL(body.url).hash.slice(1) },
  });
  assert.equal(shared.statusCode, 200, shared.body);
  assert.equal(shared.json().title, "Quarterly");
});

test("requires a valid bearer token and never reads cookies", async () => {
  const input = { key: randomUUID(), title: "No auth", html: page("No auth") };
  const missing = await publish(input);
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().code, "unauthorized");
  assert.match(
    String(missing.headers["www-authenticate"]),
    /^Bearer realm="polka"$/,
  );
  const invalid = await publish(
    input,
    bearer(randomBytes(32).toString("base64url")),
  );
  assert.equal(invalid.statusCode, 401);
  assert.match(
    String(invalid.headers["www-authenticate"]),
    /error="invalid_token"/,
  );
  // An owner's browser session is not a credential here.
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    remoteAddress: address(),
    headers: { origin },
    payload: { name: owner.name, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  const withCookie = await publish(input, { cookie, origin });
  assert.equal(withCookie.statusCode, 401);
  // A revoked connection stops working at once.
  const revoked = await token(owner);
  await db.query(
    "UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE id=$1",
    [revoked.id],
  );
  assert.equal((await publish(input, bearer(revoked.secret))).statusCode, 401);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS count FROM uploads WHERE tenant_id=$1 AND idempotency_key=$2",
        [owner.tenant, input.key],
      )
    ).rows[0].count,
    0,
  );
});

test("a browser page on another origin is refused", async () => {
  const { secret } = await token(owner);
  const response = await publish(
    { key: randomUUID(), title: "Cross", html: page("Cross") },
    { ...bearer(secret), origin: "https://evil.example" },
  );
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "forbidden");
});

test("scopes: capture is required, the link needs share", async () => {
  const reader = await token(owner, ["context", "read"]);
  const refused = await publish(
    { key: randomUUID(), title: "Reader", html: page("Reader") },
    bearer(reader.secret),
  );
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().code, "forbidden");
  const saver = await token(owner, ["context", "capture"]);
  const saved = await publish(
    { key: randomUUID(), title: "Private", html: page("Private") },
    bearer(saver.secret),
  );
  assert.equal(saved.statusCode, 200, saved.body);
  const body = saved.json();
  assert.equal(body.state, "saved");
  assert.equal(body.url, null);
  assert.equal(body.expiresAt, null);
  assert.match(body.linkUnavailableReason, /link permission/);
});

test("a retry with the same key returns the same work and link", async () => {
  const { secret } = await token(owner);
  const input = { key: randomUUID(), title: "Retry", html: page("Retry") };
  const first = await publish(input, bearer(secret));
  const second = await publish(input, bearer(secret));
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json(), first.json());
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS count FROM shares WHERE artifact_id=$1",
        [first.json().artifactId],
      )
    ).rows[0].count,
    1,
  );
  // The same key with different content is a conflict, not a second work.
  const changed = await publish(
    { ...input, html: page("Something else") },
    bearer(secret),
  );
  assert.equal(changed.statusCode, 409, changed.body);
});

test("size limits and field errors are JSON", async () => {
  const { secret } = await token(owner);
  const large = await publish(
    {
      key: randomUUID(),
      title: "Large",
      html: page("Large").replace(
        "</body>",
        `<p>${"x".repeat(MAX_BYTES)}</p></body>`,
      ),
    },
    bearer(secret),
  );
  assert.equal(large.statusCode, 413, large.body.slice(0, 200));
  assert.equal(large.json().code, "quota");
  const oversized = await publish(
    { key: randomUUID(), title: "Huge", html: "x".repeat(9 * 1024 * 1024) },
    bearer(secret),
  );
  assert.equal(oversized.statusCode, 413);
  assert.equal(typeof oversized.json().message, "string");
  const invalid = await publish(
    { key: "not-a-uuid", title: "", html: page("Invalid"), expiresInDays: 3 },
    bearer(secret),
  );
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, "invalid");
  assert.match(invalid.json().message, /key/);
  assert.match(invalid.json().message, /title/);
  assert.match(invalid.json().message, /expiresInDays/);
  const notHtml = await publish(
    { key: randomUUID(), title: "Plain", html: "just words, no markup" },
    bearer(secret),
  );
  assert.equal(notHtml.statusCode, 422, notHtml.body);
});

test("rate limits apply per connection and per address", async () => {
  const limited = await token(owner);
  await db.query(
    "INSERT INTO login_limits VALUES($1,$2,now()+interval '10 minutes')",
    [
      sha256(`api-v1:connection:${limited.id}`),
      PUBLISH_API_LIMITS.perConnection,
    ],
  );
  const input = { key: randomUUID(), title: "Limited", html: page("Limited") };
  const response = await publish(input, bearer(limited.secret));
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().code, "quota");
  const ip = address();
  await db.query(
    "INSERT INTO login_limits VALUES($1,$2,now()+interval '10 minutes')",
    [sha256(`api-v1:ip:${ip}`), PUBLISH_API_LIMITS.perIp],
  );
  const other = await token(owner);
  const byAddress = await publish(input, bearer(other.secret), ip);
  assert.equal(byAddress.statusCode, 429);
  // Unauthenticated guesses count against the address too.
  assert.equal((await publish(input, {}, ip)).statusCode, 429);
});

test("status shows works this connection saved; read sees the whole shelf", async () => {
  const publisher = await token(owner);
  const published = (
    await publish(
      { key: randomUUID(), title: "Status", html: page("Status") },
      bearer(publisher.secret),
    )
  ).json();
  const status = (secret: string, id = published.artifactId) =>
    app.inject({
      method: "GET",
      url: `/api/v1/status/${id}`,
      remoteAddress: address(),
      headers: bearer(secret),
    });
  const own = await status(publisher.secret);
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().id, published.artifactId);
  assert.equal(own.json().title, "Status");
  assert.equal(own.json().revision.id, published.revisionId);
  assert.equal(own.json().revision.htmlProfile, "static");
  assert.equal(own.json().shelfUrl, published.shelfUrl);
  const stranger = await token(owner, ["context", "capture"]);
  assert.equal((await status(stranger.secret)).statusCode, 404);
  const reader = await token(owner, ["context", "read"]);
  assert.equal((await status(reader.secret)).statusCode, 200);
  const otherOwner = await newOwner("publish-api-other");
  const outsider = await token(otherOwner, ["context", "read"]);
  assert.equal((await status(outsider.secret)).statusCode, 404);
  assert.equal((await status(reader.secret, "nope")).statusCode, 400);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/api/v1/status/${published.artifactId}`,
        remoteAddress: address(),
      })
    ).statusCode,
    401,
  );
});

test("the installation serves the CLI pointed at itself", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/cli/polka-publish.mjs",
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /^text\/javascript/);
  assert.ok(
    response.body.includes(
      `const DEFAULT_ENDPOINT = ${JSON.stringify(origin)};`,
    ),
  );
  assert.ok(!response.body.includes('"https://polochka.app";'));
});

/** Runs the real script in a child process, as a company agent would. */
function runCli(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

test("CLI publishes a file against a running server, retries idempotently", async () => {
  const server = await createApp();
  await server.listen({ host: "127.0.0.1", port: 0 });
  try {
    const endpoint = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    const { secret } = await token(owner);
    const file = join(scratch, "report.html");
    await writeFile(file, page("CLI report"));
    const key = randomUUID();
    const env = { POLKA_TOKEN: secret, POLKA_ENDPOINT: endpoint };
    const first = await runCli([file, "--share", "7", "--key", key], env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(
      first.stdout.trim(),
      new RegExp(`^${origin}/s#[A-Za-z0-9_-]{43}$`),
    );
    assert.match(first.stderr, /Saved and shared/);
    const retry = await runCli(
      [file, "--share", "7", "--key", key, "--json"],
      env,
    );
    assert.equal(retry.code, 0, retry.stderr);
    const json = JSON.parse(retry.stdout);
    assert.equal(json.url, first.stdout.trim());
    assert.equal(json.key, key);
    const artifact = await db.query("SELECT title FROM artifacts WHERE id=$1", [
      json.artifactId,
    ]);
    assert.equal(artifact.rows[0].title, "CLI report");

    const notes = join(scratch, "notes.md");
    await writeFile(notes, "# Итоги\n\n<b>не разметка</b> & списки");
    const markdown = await runCli([notes, "--json"], env);
    assert.equal(markdown.code, 0, markdown.stderr);
    const saved = JSON.parse(markdown.stdout);
    assert.equal(
      (
        await db.query("SELECT title FROM artifacts WHERE id=$1", [
          saved.artifactId,
        ])
      ).rows[0].title,
      "notes",
    );

    const denied = await runCli([file], {
      POLKA_TOKEN: randomBytes(32).toString("base64url"),
      POLKA_ENDPOINT: endpoint,
    });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /401 \(unauthorized\)/);
    assert.equal(denied.stdout, "");

    const argvToken = await runCli([file, "--token", secret], env);
    assert.equal(argvToken.code, 2);
    assert.match(argvToken.stderr, /POLKA_TOKEN/);
    const noToken = await runCli([file], { POLKA_ENDPOINT: endpoint });
    assert.equal(noToken.code, 2);
    const insecure = await runCli([file], {
      POLKA_TOKEN: secret,
      POLKA_ENDPOINT: "http://polka.example",
    });
    assert.equal(insecure.code, 2);
    assert.match(insecure.stderr, /https/);
  } finally {
    await server.close();
  }
});
