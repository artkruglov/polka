// Webhooks of a shelf (docs/specs/WEBHOOKS.md): registration with the SSRF
// check, delivery of the feed's event signed with the secret, retries with a
// growing pause, switching off after days of failures, the log, and erasure
// with the account. The network is replaced (setWebhookNetwork): nothing
// leaves the machine.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { createOwnerComment } from "../apps/server/comments.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import {
  setWebhookNetwork,
  verifyWebhookSignature,
  type SendResult,
  type WebhookRequest,
} from "../apps/server/webhook-send.ts";
import { releaseCommentAsOperator } from "../apps/server/moderation.ts";
import {
  deliverDueWebhooks,
  dispatchWebhookEvents,
  expireWebhookDeliveries,
  MAX_ATTEMPTS,
  MAX_PENDING_PER_ENDPOINT,
} from "../apps/server/webhooks.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const saved = config.WEBHOOKS;
const address = () => `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
type Account = Awaited<ReturnType<typeof createAccount>> & { cookie: string };

const PUBLIC_IP = "93.184.216.34";
const sent: WebhookRequest[] = [];
let answer: SendResult = { ok: true, status: 204, error: null, snippet: null };
const resolver = async (host: string) => [
  {
    address: host.startsWith("inside.") ? "10.0.0.7" : host.startsWith("meta.") ? "169.254.169.254" : PUBLIC_IP,
    family: 4,
  },
];

async function account(prefix: string): Promise<Account> {
  const created = await createAccount(`${prefix}-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    // Its own address: the login limit is per address, and this file signs in many people.
    remoteAddress: address(),
    headers: { origin },
    payload: { name: created.name, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  return { ...created, cookie: `polka_session=${login.cookies[0].value}` };
}
const session = (who: Account, method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url,
    remoteAddress: address(),
    headers: {
      origin,
      cookie: who.cookie,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
async function agentToken(who: Account) {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'webhooks test',$5,$6,now()+interval '1 day')`,
    [randomUUID(), who.tenant, who.id, sha256(secret), ["context", "capture", "share"], MCP_AUDIENCE],
  );
  return secret;
}
const page = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Отчёт агента.</p></body></html>`;
async function publish(token: string, title: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress: address(),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: JSON.stringify({ key: randomUUID(), title, html: page(title), expiresInDays: 7 }),
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { artifactId: string; revisionId: string };
}
/** Dispatch until the journal settles (other test files may hold transactions open). */
async function dispatchUntil(check: () => Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    await dispatchWebhookEvents();
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("the dispatcher never wrote the expected deliveries");
}
const deliveries = async (endpointId: string) =>
  (await db.query("SELECT * FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY created_at,id", [endpointId])).rows;

let owner: Account;
let token: string;

before(async () => {
  config.WEBHOOKS = "on";
  setWebhookNetwork({
    resolver,
    transport: async (request) => {
      sent.push(request);
      return answer;
    },
  });
  owner = await account("hooks");
  token = await agentToken(owner);
  // The dispatcher's first pass starts at the end of the journal.
  await dispatchWebhookEvents();
});

beforeEach(() => {
  sent.length = 0;
  answer = { ok: true, status: 204, error: null, snippet: null };
});

after(async () => {
  config.WEBHOOKS = saved;
  setWebhookNetwork();
  await app.close();
  await db.end();
  s3.destroy();
});

test("off: no routes; registration refuses http, internal addresses and too many events", async () => {
  config.WEBHOOKS = "off";
  assert.equal((await session(owner, "GET", "/api/webhooks")).statusCode, 404);
  config.WEBHOOKS = "on";
  const listed = await session(owner, "GET", "/api/webhooks");
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().items, []);
  for (const url of [
    "http://hooks.example.com/x",
    "https://localhost/x",
    "https://10.0.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://inside.example.com/x",
    "https://meta.example.com/x",
    "https://hooks.example.com:8443/x",
  ]) {
    const refused = await session(owner, "POST", "/api/webhooks", { url, events: ["revision.saved"] });
    assert.equal(refused.statusCode, 422, `${url}: ${refused.body}`);
  }
  const unknown = await session(owner, "POST", "/api/webhooks", {
    url: "https://hooks.example.com/x",
    events: ["account.erased"],
  });
  assert.equal(unknown.statusCode, 400, unknown.body);
  // Without a session, nothing.
  const anonymous = await app.inject({ method: "GET", url: "/api/webhooks", headers: { origin } });
  assert.equal(anonymous.statusCode, 401);
});

test("an event reaches the address as the feed's event, signed; ping, log and rotation", async () => {
  const created = await session(owner, "POST", "/api/webhooks", {
    url: "https://hooks.example.com/polka",
    description: "CI",
    events: ["revision.saved", "share.enabled", "comment.created"],
  });
  assert.equal(created.statusCode, 200, created.body);
  const { webhook, secret } = created.json();
  assert.match(secret, /^whsec_/);
  assert.equal(webhook.secretHint, secret.slice(0, 12));
  assert.equal(webhook.status, "active");
  // The list never shows the secret again.
  assert.doesNotMatch((await session(owner, "GET", "/api/webhooks")).body, new RegExp(secret));

  const work = await publish(token, "Отчёт для вебхука");
  await dispatchUntil(async () => (await deliveries(webhook.id)).length >= 2);
  const rows = await deliveries(webhook.id);
  assert.deepEqual(rows.map((row) => row.action).sort(), ["revision.saved", "share.enabled"]);
  assert.equal(await deliverDueWebhooks(), 2);
  assert.equal(sent.length, 2);
  for (const request of sent) {
    assert.equal(request.url, "https://hooks.example.com/polka");
    assert.ok(verifyWebhookSignature(secret, request.headers["Polka-Signature"]!, request.body));
    const event = JSON.parse(request.body);
    assert.equal(event.artifactId, work.artifactId);
    assert.equal(event.shelfId, owner.tenant);
    assert.equal(event.actorType, "agent");
    assert.match(event.id, /^\d+:\d+$/);
    assert.equal(request.headers["Polka-Event"], event.action);
    // Ids and times only: no title, no link token.
    assert.doesNotMatch(request.body, /Отчёт|#/);
  }
  const saved = JSON.parse(sent.find((request) => request.headers["Polka-Event"] === "revision.saved")!.body);
  assert.equal(saved.revisionId, work.revisionId);
  assert.deepEqual(Object.keys(saved).sort(), [
    "action",
    "actorType",
    "artifactId",
    "at",
    "id",
    "revisionId",
    "shelfId",
  ]);
  assert.ok((await deliveries(webhook.id)).every((row) => row.state === "delivered" && row.last_status === 204));

  // A comment others can see is an event too, without its text.
  sent.length = 0;
  const { rows: shares } = await db.query("SELECT id FROM shares WHERE artifact_id=$1", [work.artifactId]);
  await createOwnerComment({ id: owner.id, tenant: owner.tenant, name: owner.name }, work.artifactId, shares[0].id, {
    body: "Секретное замечание к отчёту",
    displayName: "Автор отчёта",
  });
  await dispatchUntil(async () => (await deliveries(webhook.id)).some((row) => row.action === "comment.created"));
  await deliverDueWebhooks();
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0]!.body).action, "comment.created");
  assert.doesNotMatch(sent[0]!.body, /Секретное/);

  // «Проверить»: a ping now, in the log.
  sent.length = 0;
  answer = { ok: false, status: 503, error: "http", snippet: "busy" };
  const ping = await session(owner, "POST", `/api/webhooks/${webhook.id}/ping`, {});
  assert.equal(ping.statusCode, 200, ping.body);
  assert.equal(ping.json().delivery.state, "failed");
  assert.equal(ping.json().delivery.lastStatus, 503);
  assert.equal(ping.json().delivery.responseSnippet, "busy");
  assert.equal(JSON.parse(sent[0]!.body).action, "ping");
  const log = await session(owner, "GET", `/api/webhooks/${webhook.id}/deliveries`);
  assert.equal(log.json().items.length, 4);
  // A ping does not count toward switching off.
  assert.equal((await session(owner, "GET", "/api/webhooks")).json().items[0].consecutiveFailures, 0);

  // A new secret signs from now on; the old one does not.
  const rotated = await session(owner, "POST", `/api/webhooks/${webhook.id}/rotate`, {});
  assert.equal(rotated.statusCode, 200, rotated.body);
  answer = { ok: true, status: 200, error: null, snippet: null };
  sent.length = 0;
  await session(owner, "POST", `/api/webhooks/${webhook.id}/ping`, {});
  const signature = sent[0]!.headers["Polka-Signature"]!;
  assert.ok(verifyWebhookSignature(rotated.json().secret, signature, sent[0]!.body));
  assert.ok(!verifyWebhookSignature(secret, signature, sent[0]!.body));

  // Another person's session sees nothing of it.
  const stranger = await account("hooks-stranger");
  assert.deepEqual((await session(stranger, "GET", "/api/webhooks")).json().items, []);
  assert.equal((await session(stranger, "DELETE", `/api/webhooks/${webhook.id}`)).statusCode, 404);

  const removed = await session(owner, "DELETE", `/api/webhooks/${webhook.id}`);
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal((await deliveries(webhook.id)).length, 0);
});

test("a failing address is retried with a growing pause and switched off after days of failures", async () => {
  const created = await session(owner, "POST", "/api/webhooks", {
    url: "https://hooks.example.com/down",
    events: ["revision.saved"],
  });
  const { webhook } = created.json();
  answer = { ok: false, status: 500, error: "http", snippet: "<html>boom</html>" };
  await publish(token, "Первая версия");
  await dispatchUntil(async () => (await deliveries(webhook.id)).length === 1);
  await deliverDueWebhooks();
  let [row] = await deliveries(webhook.id);
  assert.equal(row.state, "pending");
  assert.equal(row.attempts, 1);
  assert.equal(row.last_status, 500);
  assert.equal(row.response_snippet, "<html>boom</html>");
  const pause = (new Date(row.next_attempt_at).getTime() - new Date(row.last_attempt_at).getTime()) / 1000;
  assert.ok(pause >= 55 && pause <= 65, `first pause ${pause}s`);
  // Not due yet: nothing is sent.
  sent.length = 0;
  await deliverDueWebhooks();
  assert.equal(sent.length, 0);

  // The last attempt fails the delivery for good.
  await db.query("UPDATE webhook_deliveries SET attempts=$2,next_attempt_at=now() WHERE id=$1", [
    row.id,
    MAX_ATTEMPTS - 1,
  ]);
  await deliverDueWebhooks();
  [row] = await deliveries(webhook.id);
  assert.equal(row.state, "failed");
  assert.equal(row.next_attempt_at, null);

  // Failing for three days with enough attempts: switched off, the rest cancelled.
  await publish(token, "Вторая версия");
  await dispatchUntil(async () => (await deliveries(webhook.id)).length === 2);
  await db.query(
    "UPDATE webhook_endpoints SET consecutive_failures=20,failing_since=now()-interval '73 hours' WHERE id=$1",
    [webhook.id],
  );
  await deliverDueWebhooks();
  const listed = (await session(owner, "GET", "/api/webhooks"))
    .json()
    .items.find((item: any) => item.id === webhook.id);
  assert.equal(listed.status, "disabled");
  assert.equal(listed.disabledReason, "failures");
  // A disabled address gets nothing new.
  await publish(token, "Третья версия");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await dispatchWebhookEvents();
  assert.equal((await deliveries(webhook.id)).length, 2);

  // Switched on again: a fresh start.
  const on = await session(owner, "PATCH", `/api/webhooks/${webhook.id}`, { enabled: true });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(on.json().webhook.status, "active");
  assert.equal(on.json().webhook.consecutiveFailures, 0);
  await session(owner, "DELETE", `/api/webhooks/${webhook.id}`);
});

test("a department shelf: its admin manages webhooks, a curator does not; erasing the admin takes theirs", async () => {
  const savedTeam = config.TEAM_SHELVES;
  config.TEAM_SHELVES = "on";
  try {
    const admin = await account("hooks-admin");
    const curator = await account("hooks-curator");
    await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [admin.id]);
    const shelf = (
      await app.inject({
        method: "POST",
        url: "/api/shelves",
        headers: { origin, cookie: admin.cookie },
        payload: { name: "Отдел вебхуков" },
      })
    ).json();
    const added = await app.inject({
      method: "POST",
      url: `/api/shelves/${shelf.id}/members`,
      headers: { origin, cookie: admin.cookie },
      payload: { who: curator.name, role: "curator" },
    });
    assert.equal(added.statusCode, 200, added.body);
    const onShelf = (who: Account, method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET",
        url,
        remoteAddress: address(),
        headers: {
          origin,
          cookie: who.cookie,
          "x-polka-shelf": shelf.id,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    const body = { url: "https://hooks.example.com/team", events: ["revision.accepted"] };
    assert.equal((await onShelf(curator, "GET", "/api/webhooks")).statusCode, 403);
    assert.equal((await onShelf(curator, "POST", "/api/webhooks", body)).statusCode, 403);
    const created = await onShelf(admin, "POST", "/api/webhooks", body);
    assert.equal(created.statusCode, 200, created.body);
    const { rows } = await db.query("SELECT tenant_id,created_by FROM webhook_endpoints WHERE id=$1", [
      created.json().webhook.id,
    ]);
    assert.deepEqual(rows[0], { tenant_id: shelf.id, created_by: admin.id });
    const webhookId = created.json().webhook.id;
    const state = async () =>
      (await db.query("SELECT status,disabled_reason,created_by FROM webhook_endpoints WHERE id=$1", [webhookId]))
        .rows[0];
    // The curator becomes an admin, the admin a curator: the webhook stops
    // answering to anyone and is switched off with what waited.
    await db.query(
      `INSERT INTO webhook_deliveries(id,endpoint_id,tenant_id,event_id,action,payload,next_attempt_at)
       VALUES($1,$2,$3,'1:1','revision.accepted','{}',now())`,
      [randomUUID(), webhookId, shelf.id],
    );
    await db.query("UPDATE tenant_members SET role='admin' WHERE tenant_id=$1 AND account_id=$2", [
      shelf.id,
      curator.id,
    ]);
    await db.query("UPDATE tenant_members SET role='curator' WHERE tenant_id=$1 AND account_id=$2", [
      shelf.id,
      admin.id,
    ]);
    assert.deepEqual(await state(), { status: "disabled", disabled_reason: "creator", created_by: admin.id });
    assert.deepEqual(
      (await deliveries(webhookId)).map((row) => [row.state, row.last_error]),
      [["failed", "endpoint_disabled"]],
    );
    // The new admin switches it on and answers for it from now on.
    const on = await onShelf(curator, "PATCH", `/api/webhooks/${webhookId}`, { enabled: true });
    assert.equal(on.statusCode, 200, on.body);
    assert.deepEqual(await state(), { status: "active", disabled_reason: null, created_by: curator.id });
    // An operator disabling that person switches it off too.
    await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [curator.id]);
    assert.equal((await state()).disabled_reason, "creator");
    await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [curator.id]);
    // Off again: the department shelf is not found.
    config.TEAM_SHELVES = "off";
    assert.equal((await onShelf(curator, "GET", "/api/webhooks")).statusCode, 404);
    // The person who answers for it leaves Полка: their addresses go, the shelf stays.
    await db.query("UPDATE accounts SET disabled=true,deletion_requested_at=now() WHERE id=$1", [curator.id]);
    assert.equal((await db.query("SELECT 1 FROM webhook_endpoints WHERE tenant_id=$1", [shelf.id])).rowCount, 0);
  } finally {
    config.TEAM_SHELVES = savedTeam;
  }
});

test("erased with the account: the request deletes the webhooks and their log", async () => {
  const leaving = await account("hooks-leaving");
  const created = await session(leaving, "POST", "/api/webhooks", {
    url: "https://hooks.example.com/leaving",
    events: ["revision.saved"],
  });
  const { webhook } = created.json();
  await db.query(
    `INSERT INTO webhook_deliveries(id,endpoint_id,tenant_id,event_id,action,payload,state,attempts)
     VALUES($1,$2,$3,'ping:x','ping','{}','delivered',1)`,
    [randomUUID(), webhook.id, leaving.tenant],
  );
  await db.query("UPDATE accounts SET disabled=true,deletion_requested_at=now() WHERE id=$1", [leaving.id]);
  assert.equal((await db.query("SELECT 1 FROM webhook_endpoints WHERE id=$1", [webhook.id])).rowCount, 0);
  assert.equal((await db.query("SELECT 1 FROM webhook_deliveries WHERE endpoint_id=$1", [webhook.id])).rowCount, 0);

  // An older copy restored before the request: the rename that ends the erasure takes them again.
  const restored = await account("hooks-restored");
  const again = (
    await session(restored, "POST", "/api/webhooks", { url: "https://hooks.example.com/r", events: ["revision.saved"] })
  ).json().webhook;
  await db.query("UPDATE accounts SET name='deleted-'||id::text WHERE id=$1", [restored.id]);
  assert.equal((await db.query("SELECT 1 FROM webhook_endpoints WHERE id=$1", [again.id])).rowCount, 0);
});

/** A webhook of a fresh person and shelf, with deliveries queued directly. */
async function hook(prefix: string, path: string, events = ["revision.saved", "share.enabled"]) {
  const who = await account(prefix);
  const created = await session(who, "POST", "/api/webhooks", { url: `https://hooks.example.com/${path}`, events });
  assert.equal(created.statusCode, 200, created.body);
  return { who, webhook: created.json().webhook as { id: string }, secret: created.json().secret as string };
}
async function queue(endpointId: string, tenant: string, count: number, action = "revision.saved") {
  await db.query(
    `INSERT INTO webhook_deliveries(id,endpoint_id,tenant_id,event_id,action,payload,next_attempt_at)
     SELECT gen_random_uuid(),$1,$2,'q:'||g||':'||md5(random()::text),$4,'{}',now()-interval '1 second'
       FROM generate_series(1,$3) g`,
    [endpointId, tenant, count, action],
  );
}

test("one slow or failing address cannot starve the others: in-flight cap, pool and breaker", async () => {
  const slow = await hook("hooks-slow", "slow");
  const quick = await hook("hooks-quick", "quick");
  await queue(slow.webhook.id, slow.who.tenant, 6);
  await queue(quick.webhook.id, quick.who.tenant, 3);
  const live = new Map<string, number>();
  const most = new Map<string, number>();
  setWebhookNetwork({
    resolver,
    transport: async (request) => {
      live.set(request.url, (live.get(request.url) ?? 0) + 1);
      most.set(request.url, Math.max(most.get(request.url) ?? 0, live.get(request.url)!));
      await new Promise((resolve) => setTimeout(resolve, request.url.endsWith("/slow") ? 60 : 5));
      live.set(request.url, live.get(request.url)! - 1);
      return { ok: true, status: 200, error: null, snippet: null };
    },
  });
  try {
    await deliverDueWebhooks();
  } finally {
    setWebhookNetwork({ resolver, transport: async (request) => (sent.push(request), answer) });
  }
  assert.equal(most.get("https://hooks.example.com/slow"), 2, "at most two in flight per address");
  for (const id of [slow.webhook.id, quick.webhook.id])
    assert.ok((await deliveries(id)).every((row) => row.state === "delivered"));

  // A failing address: after three failures in a row it is paused as a whole.
  const failing = await hook("hooks-failing", "failing");
  await queue(failing.webhook.id, failing.who.tenant, 8);
  answer = { ok: false, status: 502, error: "http", snippet: null };
  await deliverDueWebhooks();
  const attempted = (await deliveries(failing.webhook.id)).filter((row) => row.attempts > 0).length;
  assert.ok(attempted >= 3 && attempted <= 4, `attempted ${attempted}`);
  const {
    rows: [endpoint],
  } = await db.query("SELECT paused_until>now() AS paused,consecutive_failures FROM webhook_endpoints WHERE id=$1", [
    failing.webhook.id,
  ]);
  assert.equal(endpoint.paused, true);
  // Paused: nothing more is attempted, the waiting deliveries keep their attempts.
  sent.length = 0;
  await deliverDueWebhooks();
  assert.equal(sent.length, 0);
  const listed = (await session(failing.who, "GET", "/api/webhooks")).json().items[0];
  assert.ok(listed.pausedUntil);
});

test("one shelf of slow receivers holds at most four slots of the pool", async () => {
  const first = await hook("hooks-busy-shelf", "busy-0");
  const ids = [first.webhook.id];
  for (const n of [1, 2]) {
    const more = await session(first.who, "POST", "/api/webhooks", {
      url: `https://hooks.example.com/busy-${n}`,
      events: ["revision.saved"],
    });
    assert.equal(more.statusCode, 200, more.body);
    ids.push(more.json().webhook.id);
  }
  for (const id of ids) await queue(id, first.who.tenant, 3);
  let live = 0;
  let most = 0;
  setWebhookNetwork({
    resolver,
    transport: async (request) => {
      const ours = request.url.includes("/busy-");
      if (ours) most = Math.max(most, ++live);
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (ours) live--;
      return { ok: true, status: 200, error: null, snippet: null };
    },
  });
  try {
    await deliverDueWebhooks();
  } finally {
    setWebhookNetwork({ resolver, transport: async (request) => (sent.push(request), answer) });
  }
  assert.ok(most <= 4 && most >= 3, `at most four in flight for the shelf, saw ${most}`);
  for (const id of ids) assert.ok((await deliveries(id)).every((row) => row.state === "delivered"));
});

test("a personal shelf's owner frozen for a while: webhooks pause and come back on", async () => {
  const { who, webhook } = await hook("hooks-frozen", "frozen");
  await queue(webhook.id, who.tenant, 1);
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [who.id]);
  const state = async () =>
    (await db.query("SELECT status,disabled_reason FROM webhook_endpoints WHERE id=$1", [webhook.id])).rows[0];
  assert.deepEqual(await state(), { status: "active", disabled_reason: null });
  sent.length = 0;
  await deliverDueWebhooks();
  assert.equal(sent.length, 0, "nothing is sent while the owner is frozen");
  assert.equal((await deliveries(webhook.id))[0].state, "pending");
  await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [who.id]);
  await deliverDueWebhooks();
  assert.equal(sent.length, 1);
  assert.equal((await deliveries(webhook.id))[0].state, "delivered");
});

test("an address with too many waiting deliveries skips new events and counts them", async () => {
  const full = await hook("hooks-full", "full");
  await db.query(
    `INSERT INTO webhook_deliveries(id,endpoint_id,tenant_id,event_id,action,payload,next_attempt_at)
     SELECT gen_random_uuid(),$1,$2,'full:'||g,'revision.saved','{}',now()+interval '1 day'
       FROM generate_series(1,$3) g`,
    [full.webhook.id, full.who.tenant, MAX_PENDING_PER_ENDPOINT],
  );
  await publish(await agentToken(full.who), "Лишняя работа");
  await dispatchUntil(
    async () =>
      (await db.query("SELECT skipped_events FROM webhook_endpoints WHERE id=$1", [full.webhook.id])).rows[0]
        .skipped_events >= 1,
  );
  assert.equal((await deliveries(full.webhook.id)).length, MAX_PENDING_PER_ENDPOINT);
  assert.equal((await session(full.who, "GET", "/api/webhooks")).json().items[0].skippedEvents >= 1, true);
});

test("the cursor heals itself: ahead of the cluster after a restore, and after a long pause", async () => {
  const cursor = async () =>
    (await db.query("SELECT tx::text AS tx,event_id::text AS id FROM webhook_dispatch_cursor")).rows[0];
  // A logical dump restored into a new cluster: the stored transaction number is far ahead.
  await db.query("UPDATE webhook_dispatch_cursor SET tx='99999999999'::xid8,event_id=1");
  await dispatchWebhookEvents();
  const healed = await cursor();
  assert.ok(BigInt(healed.tx) < 99999999999n, healed.tx);
  // Events after the reset are delivered again.
  const { who, webhook } = await hook("hooks-heal", "heal");
  await publish(await agentToken(who), "После восстановления");
  await dispatchUntil(async () => (await deliveries(webhook.id)).length >= 1);

  // WEBHOOKS was off for days: the cursor jumps over the day-old journal.
  const {
    rows: [old],
  } = await db.query(
    `INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id,created_at)
     VALUES($1,$2,'test.old',$2,now()-interval '3 days') RETURNING tx_id::text AS tx,id::text AS id`,
    [who.tenant, who.id],
  );
  await db.query("UPDATE webhook_dispatch_cursor SET tx=$1::xid8,event_id=$2", [old.tx, BigInt(old.id) - 1n]);
  const before = (await deliveries(webhook.id)).length;
  await publish(await agentToken(who), "После паузы");
  await dispatchUntil(async () => (await deliveries(webhook.id)).length > before);
  const moved = await cursor();
  assert.ok(BigInt(moved.tx) > BigInt(old.tx) || BigInt(moved.id) > BigInt(old.id));
});

test("a held comment the operator releases is an event then; a narrowed list cancels what waits", async () => {
  const { who, webhook } = await hook("hooks-held", "held", ["comment.created", "share.enabled"]);
  const work = await publish(await agentToken(who), "Работа с обсуждением");
  const { rows: shares } = await db.query("SELECT id FROM shares WHERE artifact_id=$1", [work.artifactId]);
  const { id } = await createOwnerComment(
    { id: who.id, tenant: who.tenant, name: who.name },
    work.artifactId,
    shares[0].id,
    {
      body: "Замечание",
      displayName: "Автор",
    },
  );
  // As if the filter had held it: hidden, and not in the journal.
  await db.query("UPDATE comments SET held_at=now() WHERE id=$1", [id]);
  await db.query("DELETE FROM audit_outbox WHERE action='comment.created' AND target_id=$1", [id]);
  await releaseCommentAsOperator(id);
  const { rows } = await db.query(
    "SELECT actor_type,payload FROM audit_outbox WHERE action='comment.created' AND target_id=$1",
    [id],
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].payload, { artifactId: work.artifactId, revisionId: work.revisionId });

  // Narrowing the events cancels waiting deliveries of the removed one.
  await dispatchUntil(async () => (await deliveries(webhook.id)).some((row) => row.action === "share.enabled"));
  const narrowed = await session(who, "PATCH", `/api/webhooks/${webhook.id}`, { events: ["comment.created"] });
  assert.equal(narrowed.statusCode, 200, narrowed.body);
  const share = (await deliveries(webhook.id)).find((row) => row.action === "share.enabled");
  assert.deepEqual([share.state, share.last_error], ["failed", "event_removed"]);
});

test("a secret that does not open is reported as such and nothing is sent", async () => {
  const one = await hook("hooks-secret-a", "a");
  const two = await hook("hooks-secret-b", "b");
  // A sealed secret copied from another row is bound to that row's id.
  await db.query(
    "UPDATE webhook_endpoints SET secret_enc=(SELECT secret_enc FROM webhook_endpoints WHERE id=$2) WHERE id=$1",
    [one.webhook.id, two.webhook.id],
  );
  sent.length = 0;
  const ping = await session(one.who, "POST", `/api/webhooks/${one.webhook.id}/ping`, {});
  assert.equal(ping.json().delivery.lastError, "secret");
  assert.equal(sent.length, 0);
});

test("a provisional shelf cannot register webhooks; old deliveries expire and leave the log", async () => {
  const guest = await account("hooks-guest");
  await db.query("UPDATE accounts SET provisional_at=now(),claimed_at=NULL WHERE id=$1", [guest.id]);
  const refused = await session(guest, "POST", "/api/webhooks", {
    url: "https://hooks.example.com/guest",
    events: ["revision.saved"],
  });
  assert.equal(refused.statusCode, 403, refused.body);

  const { who, webhook } = await hook("hooks-old", "old");
  await db.query(
    `INSERT INTO webhook_deliveries(id,endpoint_id,tenant_id,event_id,action,payload,state,next_attempt_at,created_at)
     VALUES($1,$3,$4,'old:1','revision.saved','{}','pending',now()+interval '1 day',now()-interval '8 days'),
           ($2,$3,$4,'old:2','revision.saved','{}','delivered',NULL,now()-interval '31 days')`,
    [randomUUID(), randomUUID(), webhook.id, who.tenant],
  );
  await expireWebhookDeliveries();
  const left = await deliveries(webhook.id);
  assert.deepEqual(
    left.map((row) => [row.event_id, row.state, row.last_error]),
    [["old:1", "failed", "expired"]],
  );
});
