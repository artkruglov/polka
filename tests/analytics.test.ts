// First-party product analytics (apps/server/analytics.ts, metrics.ts,
// deploy/migrations/034_product_analytics.sql): each event once, at its
// place, with pseudonymous keys only; bots ignored; sources sanitised; the
// operator report; retention math; cleanup, objection and deletion.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeProviderSignIn } from "../apps/server/account-identities.ts";
import {
  actorKey,
  flushAnalytics,
  isHumanAgent,
  oauthClientKind,
  referrerHost,
  sanitizeRef,
  trackSignup,
} from "../apps/server/analytics.ts";
import { shareKey } from "../apps/server/analytics-keys.ts";
import { publishFromAgent } from "../apps/server/agent-publish.ts";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { registerFrontend } from "../apps/server/frontend.ts";
import {
  addDays,
  funnelWeeks,
  metricsReport,
  retentionCohorts,
  weekOf,
} from "../apps/server/metrics.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
} from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { eraseDeletedAccountsAnalytics } from "../scripts/maintenance-cleanup.ts";
import { formatReport, runMetricsCli } from "../scripts/metrics.ts";

const mutable = config as any;
const saved = {
  OPS_STATUS_TOKEN: config.OPS_STATUS_TOKEN,
  MAIL_MODE: config.MAIL_MODE,
  EMAIL_SIGNUP_DAILY_LIMIT: config.EMAIL_SIGNUP_DAILY_LIMIT,
  COMMENTS_MODE: config.COMMENTS_MODE,
};
// Sign-ups here must not run into the installation's daily budget, which
// other test files spend too.
mutable.EMAIL_SIGNUP_DAILY_LIMIT = 100_000;
const app = await createApp();
const origin = config.APP_ORIGIN;
let root = "";
const run = randomBytes(4).toString("hex");
const address = () =>
  `2001:db8:a7::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

const HUMAN =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const BOTS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
  "TelegramBot (like TwitterBot)",
  "curl/8.7.1",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0 Safari/537.36",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  "",
];

// Every identifier this file creates: none may appear in a stored event.
const secrets = new Set<string>();
const actors = new Set<string>();
const remember = (...values: string[]) => {
  for (const value of values) if (value) secrets.add(value);
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), "polka-analytics-shell-"));
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><html><head><title>Полка</title></head><body><div id=root></div></body></html>",
  );
  await registerFrontend(app, root);
});

after(async () => {
  Object.assign(mutable, saved);
  await flushAnalytics();
  await rm(root, { recursive: true, force: true });
  await app.close();
  await db.end();
  s3.destroy();
});

type Person = { id: string; tenant: string; cookie: string; email: string };

async function person(label: string): Promise<Person> {
  const id = randomUUID(),
    tenant = randomUUID();
  const email = `${label}-${run}-${id.slice(0, 6)}@example.test`;
  await db.query(
    `INSERT INTO accounts(id,name,password_hash,email,display_name,trusted_at,comment_name_chosen_at)
     VALUES($1,$2,'unused',$3,$4,now(),now())`,
    [id, `email-${id}`, email, label],
  );
  await db.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
    tenant,
    id,
  ]);
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [sha256(token), id],
  );
  remember(id, tenant, email, token, `email-${id}`);
  actors.add(actorKey(id));
  return { id, tenant, cookie: `polka_session=${token}`, email };
}

function call(
  method: "GET" | "POST" | "HEAD",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    remoteAddress: address(),
    headers: { origin, ...headers },
    ...(body === undefined ? {} : { payload: body as any }),
  });
}

async function events(accountId: string, name?: string) {
  await flushAnalytics();
  return (
    await db.query(
      `SELECT * FROM analytics_events WHERE actor=$1
         AND ($2::text IS NULL OR name=$2) ORDER BY occurred_at`,
      [actorKey(accountId), name ?? null],
    )
  ).rows;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>План</title></head><body><h1>План</h1><p>Первый шаг. Второй шаг.</p></body></html>`;

async function upload(owner: Person, artifact?: { id: string; base: string }) {
  const bytes = Buffer.from(PAGE.replace("План</h1>", `План ${randomUUID()}</h1>`));
  const begin = await call(
    "POST",
    "/api/uploads",
    {
      key: randomUUID(),
      title: "План",
      filename: "page.html",
      mime: "text/html",
      size: bytes.length,
      sha256: sha256(bytes),
      ...(artifact
        ? { artifactId: artifact.id, baseRevisionId: artifact.base }
        : {}),
    },
    { cookie: owner.cookie },
  );
  assert.equal(begin.statusCode, 200, begin.body);
  const { uploadId } = begin.json();
  const put = await app.inject({
    method: "PUT",
    url: `/api/uploads/${uploadId}/bytes`,
    remoteAddress: address(),
    headers: {
      origin,
      cookie: owner.cookie,
      "content-type": "application/octet-stream",
    },
    payload: bytes,
  });
  assert.equal(put.statusCode, 200, put.body);
  const finalize = () =>
    call("POST", `/api/uploads/${uploadId}/finalize`, {}, {
      cookie: owner.cookie,
    });
  const done = await finalize();
  assert.equal(done.statusCode, 200, done.body);
  // A retried finalize returns the same receipt and records nothing new.
  assert.deepEqual((await finalize()).json(), done.json());
  return done.json() as { artifactId: string; revisionId: string };
}

async function share(owner: Person, receipt: { artifactId: string; revisionId: string }) {
  const shared = await call(
    "POST",
    `/api/artifacts/${receipt.artifactId}/share`,
    { expectedRevisionId: receipt.revisionId, expiresInDays: 7 },
    { cookie: owner.cookie },
  );
  assert.equal(shared.statusCode, 200, shared.body);
  const link = shared.json().share;
  const token = new URL(link.url).hash.slice(1);
  remember(link.id, token);
  return { shareId: link.id as string, token };
}

async function agentToken(owner: Person) {
  const id = randomUUID(),
    secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'analytics test',$5,$6,now()+interval '1 day')`,
    [id, owner.tenant, owner.id, sha256(secret), ["context", "capture", "share"], MCP_AUDIENCE],
  );
  remember(id, secret);
  return secret;
}

// ---------------------------------------------------------------------------

test("sources are sanitised and bots are recognised", () => {
  assert.equal(sanitizeRef("Habr_2026"), "habr_2026");
  assert.equal(sanitizeRef(" tg.channel-1 "), "tg.channel-1");
  assert.equal(sanitizeRef("a".repeat(40)), "a".repeat(40));
  assert.equal(sanitizeRef("a".repeat(41)), null);
  assert.equal(sanitizeRef("bad ref"), null);
  assert.equal(sanitizeRef("<script>"), null);
  assert.equal(sanitizeRef("почта"), null);
  assert.equal(sanitizeRef(["x"]), null);
  assert.equal(referrerHost("https://www.T.me/s/channel?post=1#x"), "t.me");
  assert.equal(referrerHost("https://habr.com/ru/articles/1/"), "habr.com");
  assert.equal(referrerHost(`${origin}/pricing`), null);
  assert.equal(referrerHost("javascript:alert(1)"), null);
  assert.equal(referrerHost("android-app://org.telegram.messenger/"), null);
  assert.equal(isHumanAgent(HUMAN), true);
  for (const bot of BOTS) assert.equal(isHumanAgent(bot), false, bot);
});

test("a landing page load is counted server-side: path, ref, referrer host; not bots, previews or signed-in people", async () => {
  const ref = `habr-${run}`;
  const host = `news-${run}.example`;
  const shown = await call("GET", `/?ref=${ref.toUpperCase()}&utm=x`, undefined, {
    "user-agent": HUMAN,
    referer: `https://www.${host}/story/42?token=secret`,
  });
  assert.equal(shown.statusCode, 200);
  assert.match(shown.body, /<div id=root>/);
  // The same visitor profile as a bot, a preview, a prefetch, a HEAD request
  // and a signed-in person: nothing.
  for (const agent of BOTS)
    await call("GET", `/pricing?ref=${ref}`, undefined, { "user-agent": agent });
  await call("GET", `/pricing?ref=${ref}`, undefined, {
    "user-agent": HUMAN,
    "sec-purpose": "prefetch",
  });
  await call("HEAD", `/pricing?ref=${ref}`, undefined, { "user-agent": HUMAN });
  const member = await person("visitor");
  await call("GET", `/pricing?ref=${ref}`, undefined, {
    "user-agent": HUMAN,
    cookie: member.cookie,
  });
  // A page that is not a landing page is not counted.
  await call("GET", `/terms?ref=${ref}`, undefined, { "user-agent": HUMAN });
  // /connect (the agent setup guide) opened by a person.
  const guide = await call("GET", `/connect?ref=${ref}`, undefined, {
    "user-agent": HUMAN,
  });
  assert.equal(guide.statusCode, 200);
  await flushAnalytics();
  const { rows } = await db.query(
    `SELECT * FROM analytics_events WHERE name='page_view' AND props->>'ref'=$1
     ORDER BY occurred_at`,
    [ref],
  );
  assert.deepEqual(
    rows.map((row) => row.props),
    [
      { path: "/", ref, referrer: host },
      { path: "/connect", ref },
    ],
  );
  for (const row of rows) {
    assert.equal(row.actor, null);
    assert.equal(row.subject, null);
    assert.doesNotMatch(JSON.stringify(row), /secret|story|utm|token/);
  }
  const daily = await db.query(
    `SELECT path,sum(count)::int AS count FROM analytics_daily
     WHERE name='page_view' AND source=$1 GROUP BY path ORDER BY path`,
    [`ref:${ref}`],
  );
  assert.deepEqual(daily.rows, [
    { path: "/", count: 1 },
    { path: "/connect", count: 1 },
  ]);

  // A ref outside the allowed characters or length is dropped; the referrer
  // host alone remains.
  const other = `other-${run}.example`;
  for (const bad of ["bad%20ref", "a".repeat(41), "%3Cscript%3E"])
    await call("GET", `/signup?ref=${bad}`, undefined, {
      "user-agent": HUMAN,
      referer: `https://${other}/`,
    });
  await flushAnalytics();
  const dropped = await db.query(
    "SELECT props FROM analytics_events WHERE name='page_view' AND props->>'referrer'=$1",
    [other],
  );
  assert.equal(dropped.rows.length, 3);
  for (const row of dropped.rows)
    assert.deepEqual(row.props, { path: "/signup", referrer: other });
});

test("sign-ups: one event per new account and method, with the tab's source; none for a returning person", async () => {
  // Operator-created (password).
  const operator = await createAccount(
    `analytics-${run}-${randomBytes(3).toString("hex")}`,
    randomBytes(24).toString("hex"),
  );
  remember(operator.id, operator.tenant, operator.name);
  actors.add(actorKey(operator.id));
  assert.deepEqual(
    (await events(operator.id)).map((row) => [row.name, row.props]),
    [["signup_completed", { method: "password" }]],
  );

  // Email code: the route takes the tab's source and sanitises it again.
  mutable.MAIL_MODE = "local";
  const email = `new-${run}-${randomBytes(3).toString("hex")}@example.test`;
  remember(email);
  const verify = async (source?: unknown) => {
    const id = randomUUID(),
      code = String(10_000_000 + Math.floor(Math.random() * 89_999_999)),
      browser = randomBytes(32).toString("base64url");
    await db.query(
      `INSERT INTO login_challenges(id,email,code_hash,browser_hash,delivery,expires_at)
       VALUES($1,$2,$3,$4,'local',now()+interval '10 minutes')`,
      [
        id,
        email,
        createHmac("sha256", config.LINK_KEY)
          .update(`email:${id}:${code}`)
          .digest("hex"),
        sha256(browser),
      ],
    );
    const response = await call(
      "POST",
      "/api/auth/email/verify",
      { id, code, ...(source ? { source } : {}) },
      { cookie: `polka_email_challenge=${browser}` },
    );
    assert.equal(response.statusCode, 200, response.body);
  };
  await verify({ ref: "Habr", referrer: "https://www.t.me/channel/5?x=1" });
  await verify({ ref: "ignored" });
  const {
    rows: [created],
  } = await db.query("SELECT id FROM accounts WHERE email=$1", [email]);
  remember(created.id, `email-${created.id}`);
  actors.add(actorKey(created.id));
  const emailEvents = await events(created.id, "signup_completed");
  assert.deepEqual(
    emailEvents.map((row) => row.props),
    [{ method: "email", ref: "habr", referrer: "t.me" }],
  );
  const bySource = await db.query(
    `SELECT sum(count)::int AS count FROM analytics_daily
     WHERE name='signup_completed' AND source='ref:habr' AND detail='email'`,
  );
  assert.ok(bySource.rows[0].count >= 1);

  // Яндекс ID: a new shelf once; the same person signing in again is not new.
  const profile = {
    provider: "yandex" as const,
    subject: `analytics-${run}-${randomBytes(4).toString("hex")}`,
    email: null,
    emailVerified: false,
    name: "Гость",
  };
  const first = await completeProviderSignIn(profile, null, address(), {
    referrer: "vk.com",
  });
  await completeProviderSignIn(profile, null, address(), { ref: "again" });
  remember(first.accountId, profile.subject);
  actors.add(actorKey(first.accountId));
  assert.deepEqual(
    (await events(first.accountId, "signup_completed")).map((row) => row.props),
    [{ method: "yandex", referrer: "vk.com" }],
  );
  // A sign-up is also the account's first active day.
  const active = await db.query(
    "SELECT count(*)::int AS n FROM analytics_active_days WHERE actor=$1",
    [actorKey(first.accountId)],
  );
  assert.equal(active.rows[0].n, 1);
});

test("saves, links, openings and notes: once each, with via and first", async () => {
  const owner = await person("owner");
  const receipt = await upload(owner);
  const second = await upload(owner, {
    id: receipt.artifactId,
    base: receipt.revisionId,
  });
  const saves = await events(owner.id, "work_saved");
  assert.deepEqual(
    saves.map((row) => row.props),
    [
      { via: "web", first: true, kind: "new" },
      { via: "web", first: false, kind: "revision" },
    ],
  );

  const link = await share(owner, second);
  // Asking again for the open link returns it: no second event.
  await share(owner, second);
  assert.deepEqual(
    (await events(owner.id, "share_created")).map((row) => row.props),
    [{ via: "web", first: true }],
  );

  // The owner looking at their own link is not counted; a recipient is,
  // once a day however many times they open it.
  const resolve = (headers: Record<string, string> = {}) =>
    call("POST", "/api/resolve", { token: link.token }, headers);
  assert.equal((await resolve({ cookie: owner.cookie })).statusCode, 200);
  assert.equal((await events(owner.id, "share_opened")).length, 0);
  for (let view = 0; view < 3; view++)
    assert.equal((await resolve()).statusCode, 200);
  const opened = await events(owner.id, "share_opened");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].subject, shareKey(link.shareId));
  assert.notEqual(opened[0].subject, link.shareId);
  assert.deepEqual(opened[0].props, {});

  // A note by the owner on the link.
  mutable.COMMENTS_MODE = "on";
  const note = await call(
    "POST",
    `/api/artifacts/${second.artifactId}/comments`,
    {
      shareId: link.shareId,
      body: "Проверить второй шаг",
      anchor: { exact: "Второй шаг.", prefix: "Первый шаг. ", suffix: "" },
    },
    { cookie: owner.cookie },
  );
  if (note.statusCode === 200 || note.statusCode === 201)
    assert.deepEqual(
      (await events(owner.id, "note_added")).map((row) => row.props),
      [{ by: "owner", via: "web" }],
    );
  else assert.fail(`note: ${note.statusCode} ${note.body}`);

  // Any signed-in action marks the day as active, once.
  const days = await db.query(
    "SELECT day::text FROM analytics_active_days WHERE actor=$1",
    [actorKey(owner.id)],
  );
  assert.deepEqual(
    days.rows.map((row) => row.day),
    [new Date().toISOString().slice(0, 10)],
  );
});

test("agents: a token's first call connects it (HTTP or MCP); saves say api or agent", async () => {
  const owner = await person("agent-owner");
  const http = await agentToken(owner);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/publish",
      remoteAddress: address(),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${http}`,
      },
      payload: JSON.stringify({
        key: randomUUID(),
        title: `API ${attempt}`,
        html: PAGE,
        expiresInDays: 7,
      }),
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const mcpSecret = await agentToken(owner);
  const actor = await authenticateServiceToken(mcpSecret, MCP_AUDIENCE);
  await authenticateServiceToken(mcpSecret, MCP_AUDIENCE);
  await publishFromAgent(actor, {
    key: randomUUID(),
    title: "Chat",
    html: PAGE,
    expiresInDays: 7,
  });
  assert.deepEqual(
    (await events(owner.id, "agent_connected")).map((row) => row.props),
    [
      { client: "token-http", first: true },
      { client: "token-mcp", first: false },
    ],
  );
  assert.deepEqual(
    (await events(owner.id, "work_saved")).map((row) => row.props),
    [
      { via: "api", first: true, kind: "new" },
      { via: "api", first: false, kind: "new" },
      { via: "agent", first: false, kind: "new" },
    ],
  );
  assert.deepEqual(
    (await events(owner.id, "share_created")).map((row) => row.props),
    [
      { via: "api", first: true },
      { via: "api", first: false },
      { via: "agent", first: false },
    ],
  );
});

test("OAuth clients are told apart by their return address and name", () => {
  assert.equal(
    oauthClientKind("Claude", ["https://claude.ai/api/mcp/auth_callback"]),
    "claude-ai",
  );
  assert.equal(
    oauthClientKind("ChatGPT", ["https://chatgpt.com/connector_platform_oauth_redirect"]),
    "chatgpt",
  );
  assert.equal(
    oauthClientKind("Codex", ["http://127.0.0.1:43123/callback"]),
    "codex",
  );
  assert.equal(
    oauthClientKind("Claude Code (polka)", ["http://localhost:5555/callback"]),
    "claude-code",
  );
  // A name alone cannot claim a vendor's web client.
  assert.equal(
    oauthClientKind("Claude", ["https://evil.example/callback"]),
    "other",
  );
  assert.equal(oauthClientKind(null, ["not a url"]), "other");
});

test("a company request is counted once, without who sent it", async () => {
  const key = randomUUID();
  const company = `Компания ${run}`;
  const body = {
    key,
    name: "Анна",
    company,
    email: `anna-${run}@example.test`,
    teamSize: "11-50",
    interest: "self-hosted",
    policyRead: true,
  };
  const before = await db.query(
    "SELECT count(*)::int AS n FROM analytics_events WHERE name='enterprise_request'",
  );
  const first = await call("POST", "/api/enterprise-requests", body);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(
    (await call("POST", "/api/enterprise-requests", body)).statusCode,
    200,
  );
  await flushAnalytics();
  const { rows } = await db.query(
    `SELECT * FROM analytics_events WHERE name='enterprise_request'
     ORDER BY occurred_at DESC`,
  );
  // Other files may send requests too: at least ours, and ours has no identity.
  assert.ok(rows.length >= before.rows[0].n + 1);
  const ours = rows.filter(
    (row) => row.props.interest === "self-hosted" && row.props.teamSize === "11-50",
  );
  assert.ok(ours.length >= 1);
  for (const row of rows) {
    assert.equal(row.actor, null);
    assert.doesNotMatch(JSON.stringify(row), new RegExp(`${run}|Анна`));
  }
});

test("stored rows hold no personal data: fixed columns, keys only, enumerated props", async () => {
  await flushAnalytics();
  const columns = async (table: string) =>
    (
      await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
        [table],
      )
    ).rows.map((row) => row.column_name);
  assert.deepEqual(await columns("analytics_events"), [
    "id",
    "occurred_at",
    "day",
    "name",
    "actor",
    "subject",
    "props",
  ]);
  assert.deepEqual(await columns("analytics_daily"), [
    "day",
    "name",
    "path",
    "source",
    "detail",
    "count",
  ]);
  assert.deepEqual(await columns("analytics_active_days"), ["actor", "day"]);
  assert.deepEqual(await columns("analytics_optouts"), ["actor", "created_at"]);
  const allowed = new Set([
    "path",
    "ref",
    "referrer",
    "method",
    "client",
    "first",
    "via",
    "kind",
    "by",
    "interest",
    "teamSize",
  ]);
  const { rows } = await db.query(
    "SELECT * FROM analytics_events WHERE actor=ANY($1::text[])",
    [[...actors]],
  );
  assert.ok(rows.length >= 10, String(rows.length));
  for (const row of rows) {
    assert.match(row.actor, /^[A-Za-z0-9_-]{43}$/);
    for (const key of Object.keys(row.props))
      assert.ok(allowed.has(key), `unexpected prop ${key}`);
    const text = JSON.stringify(row);
    for (const secret of secrets)
      assert.ok(!text.includes(secret), `${row.name} holds an identifier`);
    assert.doesNotMatch(text, /2001:db8|127\.0\.0\.1|@example\.test/);
  }
});

test("the operator report: token-gated like /api/ops/status, with the funnel, sources, agents and retention", async () => {
  const token = randomBytes(24).toString("hex");
  mutable.OPS_STATUS_TOKEN = undefined;
  const get = (url: string, authorization?: string) =>
    call("GET", url, undefined, authorization ? { authorization } : {});
  assert.equal((await get("/api/ops/metrics", `Bearer ${token}`)).statusCode, 404);
  assert.equal((await get("/ops/metrics")).statusCode, 404);
  mutable.OPS_STATUS_TOKEN = token;
  assert.equal((await get("/api/ops/metrics")).statusCode, 404);
  assert.equal((await get("/api/ops/metrics", `Bearer ${token}x`)).statusCode, 404);
  assert.equal(
    (await get("/api/ops/metrics?weeks=100", `Bearer ${token}`)).statusCode,
    400,
  );
  const answer = await get("/api/ops/metrics?weeks=4", `Bearer ${token}`);
  assert.equal(answer.statusCode, 200, answer.body);
  const report = answer.json();
  assert.deepEqual(Object.keys(report).sort(), [
    "activity",
    "agentClients",
    "definitions",
    "funnel",
    "generatedAt",
    "pages",
    "retention",
    "signupMethods",
    "since",
    "sources",
    "today",
    "totals",
    "weeks",
  ]);
  assert.equal(report.weeks, 4);
  assert.equal(report.funnel.weeks.length, 4);
  assert.deepEqual(report.funnel.steps, [
    "visitors",
    "signups",
    "agentConnected",
    "firstSave",
    "firstShare",
    "shareOpened",
  ]);
  const week = report.funnel.weeks.at(-1);
  for (const key of ["week", "visitors", "signups", "agentConnected", "firstSave", "firstShare", "shareOpened", "reached", "conversion"])
    assert.ok(key in week, key);
  assert.ok(week.signups >= 3);
  assert.ok(report.funnel.total.visitors >= 2);
  assert.ok(report.sources.some((row: any) => row.source === "ref:habr" && row.signups >= 1));
  assert.ok(report.agentClients.some((row: any) => row.client === "token-http"));
  assert.deepEqual(Object.keys(report.retention[0]).sort(), ["cohort", "d1", "d30", "d7", "week"]);
  assert.ok(report.totals.allTime.signup_completed >= 3);
  assert.ok(report.activity.at(-1).activeAccounts >= 1);
  // No identifier of any kind in the report.
  const text = answer.body;
  for (const secret of secrets) assert.ok(!text.includes(secret));
  for (const actor of actors) assert.ok(!text.includes(actor));

  // The page: no data, the app's CSP, script and styles from this origin.
  const page = await get("/ops/metrics");
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] as string, /text\/html/);
  assert.match(page.body, /<script src="\/ops\/metrics\.js" defer><\/script>/);
  assert.doesNotMatch(page.body, /<script>|style=/);
  assert.match(page.headers["content-security-policy"] as string, /script-src 'self'/);
  const script = await get("/ops/metrics.js");
  assert.equal(script.statusCode, 200);
  assert.match(script.headers["content-type"] as string, /javascript/);
  assert.match(script.body, /sessionStorage/);
  assert.doesNotMatch(script.body, /innerHTML|localStorage|document\.cookie/);
  assert.equal((await get("/ops/metrics.css")).statusCode, 200);

  // The CLI prints the same report.
  const printed = await runMetricsCli(["--weeks", "4"]);
  assert.match(printed, /Воронка/);
  assert.match(printed, /Удержание/);
  assert.match(formatReport(await metricsReport({ weeks: 2 })), /Источники/);
});

test("funnel and retention on a synthetic cohort", () => {
  const today = "2026-09-24"; // a Thursday
  assert.equal(weekOf(today), "2026-09-21");
  assert.equal(weekOf("2026-09-20"), "2026-09-14");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  const weeks = ["2026-08-03", "2026-08-10"];
  const signups = [
    { actor: "a", day: "2026-08-03" },
    { actor: "b", day: "2026-08-04" },
    { actor: "c", day: "2026-08-05" },
    { actor: "d", day: "2026-08-09" },
    { actor: "e", day: "2026-08-10" },
  ];
  const active = new Map<string, Set<string>>([
    ["a", new Set(["2026-08-03", "2026-08-04", "2026-08-10", "2026-09-02"])],
    ["b", new Set(["2026-08-04", "2026-08-12"])], // day 8: D7, not D1
    ["c", new Set(["2026-08-06", "2026-09-04"])], // D1 and day 30: D30
    ["d", new Set(["2026-08-09"])],
    ["e", new Set(["2026-08-11", "2026-08-17", "2026-09-15"])],
  ]);
  const cohorts = retentionCohorts(weeks, signups, active, today);
  assert.deepEqual(cohorts[0], {
    week: "2026-08-03",
    cohort: 4,
    d1: { eligible: 4, retained: 2, rate: 0.5 },
    d7: { eligible: 4, retained: 2, rate: 0.5 },
    d30: { eligible: 4, retained: 2, rate: 0.5 },
  });
  // e signed up on 2026-08-10: day 30–36 ends 2026-09-15, before today.
  assert.deepEqual(cohorts[1].d30, { eligible: 1, retained: 1, rate: 1 });
  // A window not over yet is not counted.
  const young = retentionCohorts(
    ["2026-09-21"],
    [{ actor: "f", day: "2026-09-23" }],
    new Map([["f", new Set(["2026-09-24"])]]),
    today,
  );
  assert.deepEqual(young[0].d1, { eligible: 0, retained: 0, rate: null });

  const reached = new Map<string, Set<any>>([
    ["a", new Set(["agentConnected", "firstSave", "firstShare", "shareOpened"])],
    ["b", new Set(["agentConnected", "firstSave"])],
    ["c", new Set(["firstSave", "firstShare"])], // saved from the web, no agent
    ["e", new Set(["agentConnected"])],
  ]);
  const funnel = funnelWeeks(
    weeks,
    signups,
    reached,
    new Map([["2026-08-03", 40]]),
  );
  const first = funnel.weeks[0]!;
  assert.equal(first.visitors, 40);
  assert.equal(first.signups, 4);
  assert.equal(first.agentConnected, 2);
  assert.equal(first.firstSave, 2);
  assert.equal(first.firstShare, 1);
  assert.equal(first.shareOpened, 1);
  assert.deepEqual(first.reached, {
    agentConnected: 2,
    firstSave: 3,
    firstShare: 2,
    shareOpened: 1,
  });
  assert.equal(first.conversion.visitorToSignup, 0.1);
  assert.equal(first.conversion.signupToAgent, 0.5);
  assert.equal(first.conversion.saveToShare, 0.5);
  assert.equal(funnel.weeks[1]!.conversion.visitorToSignup, null);
  assert.equal(funnel.total.signups, 5);
  assert.equal(funnel.total.agentConnected, 3);
});

test("maintenance keeps raw events and active days 13 months; the daily counters stay", async () => {
  const source = await readFile(
    new URL("../scripts/maintenance-cleanup.ts", import.meta.url),
    "utf8",
  );
  const statements = [
    ...source.matchAll(/"(DELETE FROM analytics_[a-z_]+ WHERE [^"]+13 months[^"]+)"/g),
  ].map((match) => match[1]!);
  assert.equal(statements.length, 2);
  assert.doesNotMatch(source, /DELETE FROM analytics_daily/);
  const actor = actorKey(randomUUID());
  const insert = (age: string) =>
    db.query(
      `INSERT INTO analytics_events(id,occurred_at,day,name,actor,props)
       VALUES($1,now()-$2::interval,(now()-$2::interval)::date,'work_saved',$3,'{}')`,
      [randomUUID(), age, actor],
    );
  await insert("13 months 2 days");
  await insert("12 months");
  await db.query(
    `INSERT INTO analytics_active_days(actor,day) VALUES
       ($1,(now()-interval '13 months 2 days')::date),($1,(now()-interval '12 months')::date)`,
    [actor],
  );
  const day = (await db.query("SELECT (now()-interval '14 months')::date::text AS d")).rows[0].d;
  await db.query(
    `INSERT INTO analytics_daily(day,name,count) VALUES($1,'page_view',7)
     ON CONFLICT(day,name,path,source,detail) DO UPDATE SET count=analytics_daily.count+7`,
    [day],
  );
  for (const sql of statements) await db.query(sql);
  const left = await db.query(
    "SELECT count(*)::int AS n FROM analytics_events WHERE actor=$1",
    [actor],
  );
  assert.equal(left.rows[0].n, 1);
  const days = await db.query(
    "SELECT count(*)::int AS n FROM analytics_active_days WHERE actor=$1",
    [actor],
  );
  assert.equal(days.rows[0].n, 1);
  const kept = await db.query(
    "SELECT count::int FROM analytics_daily WHERE day=$1::date AND name='page_view' AND path=''",
    [day],
  );
  assert.ok(kept.rows[0].count >= 7);
});

test("an objection (metrics forget) deletes the account's events and stops new ones", async () => {
  const who = await person("objector");
  const receipt = await upload(who);
  await share(who, receipt);
  assert.ok((await events(who.id)).length >= 2);
  const message = await runMetricsCli(["forget", who.email]);
  assert.match(message, /^Deleted \d+ events and \d+ active days/);
  assert.equal((await events(who.id)).length, 0);
  const days = await db.query(
    "SELECT count(*)::int AS n FROM analytics_active_days WHERE actor=$1",
    [actorKey(who.id)],
  );
  assert.equal(days.rows[0].n, 0);
  // New actions are no longer recorded for this account.
  await upload(who);
  await transaction(async (c) => trackSignup(c, who.id, "email"));
  assert.equal((await events(who.id)).length, 0);
  await call("GET", "/api/me", undefined, { cookie: who.cookie });
  await flushAnalytics();
  const after = await db.query(
    "SELECT count(*)::int AS n FROM analytics_active_days WHERE actor=$1",
    [actorKey(who.id)],
  );
  assert.equal(after.rows[0].n, 0);
  await assert.rejects(runMetricsCli(["forget", `nobody-${run}@example.test`]), /No such account/);
});

test("a deleted account's events go: maintenance sweeps every deletion request (purge, restore)", async () => {
  const leaving = await person("leaving");
  const staying = await person("staying");
  await upload(leaving);
  await upload(staying);
  assert.ok((await events(leaving.id)).length >= 1);
  await db.query(
    "UPDATE accounts SET disabled=true,deletion_requested_at=now() WHERE id=$1",
    [leaving.id],
  );
  const client = await db.connect();
  try {
    await eraseDeletedAccountsAnalytics(client, actorKey);
  } finally {
    client.release();
  }
  assert.equal((await events(leaving.id)).length, 0);
  const days = await db.query(
    "SELECT count(*)::int AS n FROM analytics_active_days WHERE actor=$1",
    [actorKey(leaving.id)],
  );
  assert.equal(days.rows[0].n, 0);
  assert.ok((await events(staying.id)).length >= 1);
});
