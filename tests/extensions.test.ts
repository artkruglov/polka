// Extensions of the open core (docs/specs/EXTENSIONS.md): a link policy that
// refuses and one that asks recipients to sign in, events after the commit,
// routes of their own, and loading by path. Without extensions the core
// behaves as alone (every other test runs without them).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { PolkaEvent, PolkaExtension } from "../packages/extension-api/index.ts";
import { loadExtensions, useExtensions } from "../apps/server/extensions.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const events: PolkaEvent[] = [];
const policy: PolkaExtension = {
  name: "policy",
  register(app, context) {
    app.get("/api/ext/policy/whoami", async (req) => ({ name: (await context.identity(req)).name }));
  },
  policies: {
    async linkIssue(issue) {
      return issue.expiresInDays > 7
        ? { allow: false, message: "Ссылки дольше 7 дней в компании запрещены." }
        : { allow: true };
    },
    async linkOpen(open) {
      return open.viewer ? { allow: true } : { allow: false, signIn: true, message: "Ссылка только для сотрудников компании." };
    },
  },
  onEvent(event) {
    events.push(event);
  },
};
useExtensions([policy]);
const { createApp } = await import("../apps/server/app.ts");
const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";

const call = (method: any, url: string, body?: unknown, withCookie = true) =>
  app.inject({
    method,
    url,
    headers: {
      origin,
      ...(withCookie ? { cookie } : {}),
      ...(Buffer.isBuffer(body) ? { "content-type": "application/octet-stream" } : {}),
    },
    payload: body as any,
  });

before(async () => {
  owner = await createAccount(`ext-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({ method: "POST", url: "/api/login", headers: { origin }, payload: { name: owner.name, password } });
  cookie = `polka_session=${login.cookies[0].value}`;
});

after(async () => {
  useExtensions([]);
  await app.close();
  await db.end();
  s3.destroy();
});

test("an extension's policy refuses a link and asks recipients to sign in; events follow the commit", async () => {
  const body = Buffer.from("<!doctype html><title>Отчёт</title><h1>Отчёт</h1><p>Текст.</p>");
  const start = await call("POST", "/api/uploads", {
    key: randomUUID(), title: "Отчёт", filename: "r.html", mime: "text/html", size: body.length, sha256: sha256(body),
  });
  assert.equal(start.statusCode, 200, start.body);
  await call("PUT", `/api/uploads/${start.json().uploadId}/bytes`, body);
  const saved = (await call("POST", `/api/uploads/${start.json().uploadId}/finalize`, {})).json();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "revision.saved" && event.revisionId === saved.revisionId));

  const refused = await call("POST", `/api/artifacts/${saved.artifactId}/share`, { expectedRevisionId: saved.revisionId, expiresInDays: 30 });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.match(refused.json().message, /дольше 7 дней/);
  const shared = await call("POST", `/api/artifacts/${saved.artifactId}/share`, { expectedRevisionId: saved.revisionId, expiresInDays: 7 });
  assert.equal(shared.statusCode, 200, shared.body);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "share.created" && event.shareId === shared.json().share.id));

  const token = new URL(shared.json().share.url).hash.slice(1);
  const anonymous = await call("POST", "/api/resolve", { token }, false);
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  assert.equal(anonymous.json().reason, "sign_in_required");
  assert.match(anonymous.json().message, /только для сотрудников/);
  const signedIn = await call("POST", "/api/resolve", { token });
  assert.equal(signedIn.statusCode, 200, signedIn.body);

  const whoami = await call("GET", "/api/ext/policy/whoami");
  assert.equal(whoami.json().name, owner.name);
});

test("an extension loads by path and must name itself", async () => {
  const [hello] = await loadExtensions("./tests/fixtures/extension-hello.mjs");
  assert.equal(hello!.name, "hello");
  await assert.rejects(loadExtensions("./tests/fixtures/extension-hello.mjs,./tests/fixtures/extension-hello.mjs"), /loaded twice/);
  useExtensions([policy]);
});
