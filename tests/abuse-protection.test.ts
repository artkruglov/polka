// Abuse protection for open sign-up (docs/specs/ABUSE_PROTECTION.md, 1–7):
// account trust, new-account limits, SHARE_MODERATION, the recipient's
// review screen, report auto-pause, operator letters with one-click actions,
// and phishing signals.
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { registerFrontend } from "../apps/server/frontend.ts";
import { inspectHtml, inspectHtmlBounded } from "../apps/server/html.ts";
import { LOCAL_OPERATOR_MAIL_DIRECTORY } from "../apps/server/mailer.ts";
import {
  signModerationToken,
  verifyModerationToken,
} from "../apps/server/moderation-tokens.ts";
import {
  SCAN_INCOMPLETE,
  SignalCollector,
  isSuspicious,
  scanScript,
} from "../apps/server/phishing-signals.ts";
import {
  authorStanding,
  decideModeration,
} from "../apps/server/share-moderation.ts";
import { publishResponseSchema } from "../apps/server/publish-api.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
if (config.MAIL_MODE !== "local")
  throw new Error("Abuse-protection tests read operator letters from local mail");
const password = randomBytes(24).toString("hex");
const defaults = {
  SHARE_MODERATION: config.SHARE_MODERATION,
  OPERATOR_EMAIL: config.OPERATOR_EMAIL,
  MODERATION_AUTOPAUSE_REPORTS: config.MODERATION_AUTOPAUSE_REPORTS,
  NEW_ACCOUNT_MAX_LINKS: config.NEW_ACCOUNT_MAX_LINKS,
};
config.OPERATOR_EMAIL = "operator@example.test";

afterEach(() => {
  config.SHARE_MODERATION = defaults.SHARE_MODERATION;
  config.MODERATION_AUTOPAUSE_REPORTS = defaults.MODERATION_AUTOPAUSE_REPORTS;
  config.NEW_ACCOUNT_MAX_LINKS = defaults.NEW_ACCOUNT_MAX_LINKS;
});

after(async () => {
  // Letters are sent after the response; let the last ones settle.
  await new Promise((resolve) => setTimeout(resolve, 300));
  config.OPERATOR_EMAIL = defaults.OPERATOR_EMAIL;
  await app.close();
  await db.end();
  s3.destroy();
});

const address = () =>
  `2001:db8:a::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

type Owner = { id: string; tenant: string; cookie: string };

async function session(accountId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [sha256(token), accountId],
  );
  return `polka_session=${token}`;
}

/** An account that signed up by email, `ageDays` ago. */
async function signedUp(ageDays = 0): Promise<Owner> {
  const id = randomUUID(),
    tenant = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,name,password_hash,email,created_at)
     VALUES($1,$2,'unused',$3,now()-$4*interval '1 day')`,
    [id, `email-${id}`, `new-${id.slice(0, 8)}@example.test`, ageDays],
  );
  await db.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [tenant, id]);
  return { id, tenant, cookie: await session(id) };
}

async function operatorCreated(): Promise<Owner> {
  const created = await createAccount(
    `abuse-${randomBytes(4).toString("hex")}`,
    password,
  );
  return { ...created, cookie: await session(created.id) };
}

function call(method: "GET" | "POST", url: string, body?: unknown, cookie = "") {
  return app.inject({
    method,
    url,
    remoteAddress: address(),
    headers: { origin, ...(cookie ? { cookie } : {}) },
    payload: body as any,
  });
}

async function save(owner: Owner, html: string, title = "Страница") {
  const bytes = Buffer.from(html);
  const begin = await call(
    "POST",
    "/api/uploads",
    {
      key: randomUUID(),
      title,
      filename: "page.html",
      mime: "text/html",
      size: bytes.length,
      sha256: sha256(bytes),
    },
    owner.cookie,
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
  const done = await call(
    "POST",
    `/api/uploads/${uploadId}/finalize`,
    {},
    owner.cookie,
  );
  assert.equal(done.statusCode, 200, done.body);
  return done.json() as { artifactId: string; revisionId: string };
}

async function share(
  owner: Owner,
  receipt: { artifactId: string; revisionId: string },
  days = 7,
) {
  return call(
    "POST",
    `/api/artifacts/${receipt.artifactId}/share`,
    { expectedRevisionId: receipt.revisionId, expiresInDays: days },
    owner.cookie,
  );
}

async function sharedLink(owner: Owner, html: string, title?: string) {
  const receipt = await save(owner, html, title);
  const response = await share(owner, receipt);
  assert.equal(response.statusCode, 200, response.body);
  const artifact = response.json();
  return {
    ...receipt,
    shareId: artifact.share.id as string,
    moderation: artifact.share.moderation as string,
    token: new URL(artifact.share.url).hash.slice(1),
  };
}

const resolve = (token: string) => call("POST", "/api/resolve", { token });

const HONEST = `<!doctype html><html><head><meta charset="utf-8"><title>Отчёт</title></head><body><h1>Квартальный отчёт</h1><p>${"Выручка выросла на 12%, расходы стабильны. ".repeat(4)}</p></body></html>`;
// Static (no form, no password input), so it can be linked everywhere.
const PHISHING = `<!doctype html><html><head><meta charset="utf-8"><title>СберБанк Онлайн</title></head><body><h1>СберБанк</h1><p>Ваша карта заблокирована. Срочно подтвердите данные.</p><label>Номер карты <input name="card_number" placeholder="0000 0000 0000 0000"></label><input name="sms_code" placeholder="Код из SMS"></body></html>`;

type Letter = { to: string; subject: string; text: string; html: string };

/** Operator letters about one link, waiting up to 5 s for `count` of them. */
async function letters(shareId: string, count = 1) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    let found: Letter[] = [];
    try {
      const names = (await readdir(LOCAL_OPERATOR_MAIL_DIRECTORY)).sort();
      for (const name of names) {
        const letter = JSON.parse(
          await readFile(join(LOCAL_OPERATOR_MAIL_DIRECTORY, name), "utf8"),
        ) as Letter;
        if (letter.text.includes(shareId)) found.push(letter);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (found.length >= count || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The token behind a button of a letter. */
function button(letter: Letter, label: string) {
  const line = letter.text
    .split("\n")
    .find((row) => row.startsWith(`${label}: `));
  assert.ok(line, `no «${label}» in ${letter.text}`);
  const url = new URL(line.slice(label.length + 2));
  assert.equal(url.origin + url.pathname, `${origin}/moderation`);
  return url.hash.slice(1);
}

const moderation = (path: string, token: string) =>
  call("POST", `/api/moderation/${path}`, { token });

const shareRow = async (shareId: string) =>
  (await db.query("SELECT * FROM shares WHERE id=$1", [shareId])).rows[0];

test("trust: operator-created, approved, or old without open reports; a paused link revokes it", async () => {
  const operator = await operatorCreated();
  assert.equal((await authorStanding(db, operator.tenant)).trusted, true);
  const fresh = await signedUp(0);
  assert.equal((await authorStanding(db, fresh.tenant)).trusted, false);
  const old = await signedUp(8);
  assert.equal((await authorStanding(db, old.tenant)).trusted, true);
  // An open report takes the age path away until the operator settles it.
  const link = await sharedLink(old, HONEST);
  await call("POST", "/api/reports", {
    key: randomUUID(),
    token: link.token,
    reason: "other",
  });
  assert.equal((await authorStanding(db, old.tenant)).trusted, false);
  // Approval makes an account trusted regardless of age...
  const approved = await signedUp(0);
  await db.query("UPDATE accounts SET trusted_at=now() WHERE id=$1", [
    approved.id,
  ]);
  const approvedLink = await sharedLink(approved, HONEST);
  assert.equal((await authorStanding(db, approved.tenant)).trusted, true);
  // ...until one of its links is paused after reports.
  await db.query("UPDATE shares SET moderation='paused' WHERE id=$1", [
    approvedLink.shareId,
  ]);
  assert.equal((await authorStanding(db, approved.tenant)).trusted, false);
  // Accounts that existed before migration 029 were backfilled as trusted,
  // and created_at stays NULL (old) for them.
  const legacy = (
    await db.query(
      "SELECT count(*)::int AS n FROM accounts WHERE created_at IS NULL AND trusted_at IS NULL",
    )
  ).rows[0].n;
  assert.equal(legacy, 0);
});

test("new accounts: 7-day links and a live-link cap, each refused with a reason", async () => {
  config.SHARE_MODERATION = "off";
  config.NEW_ACCOUNT_MAX_LINKS = 2;
  const owner = await signedUp(0);
  const long = await share(owner, await save(owner, HONEST), 30);
  assert.equal(long.statusCode, 422, long.body);
  assert.equal(long.json().code, "quota");
  assert.match(long.json().message, /не больше чем на 7 дней/);
  assert.match(long.json().message, /Выберите срок 1 или 7 дней/);
  await sharedLink(owner, HONEST);
  await sharedLink(owner, HONEST);
  const third = await share(owner, await save(owner, HONEST));
  assert.equal(third.statusCode, 429, third.body);
  assert.match(third.json().message, /открыто 2 ссылки/);
  assert.match(third.json().message, /не больше 2/);
  assert.match(third.json().message, /Закройте ссылку/);
  // A trusted author has neither limit.
  const operator = await operatorCreated();
  const month = await share(operator, await save(operator, HONEST), 30);
  assert.equal(month.statusCode, 200, month.body);
});

test("SHARE_MODERATION decides which new links wait", async () => {
  const fresh = await signedUp(0);
  const approved = await signedUp(0);
  await db.query("UPDATE accounts SET trusted_at=now() WHERE id=$1", [
    approved.id,
  ]);
  const operator = await operatorCreated();
  const cases: Array<[string, Owner, string, string]> = [
    ["off", fresh, PHISHING, "none"],
    ["flagged", fresh, HONEST, "none"],
    ["flagged", fresh, PHISHING, "held"],
    ["flagged", operator, PHISHING, "none"],
    ["new-accounts", fresh, HONEST, "held"],
    ["new-accounts", approved, HONEST, "none"],
    ["new-accounts", approved, PHISHING, "none"],
    ["all", approved, HONEST, "held"],
    ["all", operator, HONEST, "none"],
  ];
  for (const [mode, owner, page, expected] of cases) {
    config.SHARE_MODERATION = mode as typeof config.SHARE_MODERATION;
    await db.query(
      "UPDATE shares SET revoked=true WHERE tenant_id=$1",
      [owner.tenant],
    );
    const link = await sharedLink(owner, page);
    assert.equal(link.moderation, expected, `${mode}`);
    assert.equal((await shareRow(link.shareId)).moderation, expected, mode);
  }
  // The decision itself, without the database.
  const standing = await authorStanding(db, fresh.tenant);
  const signals = inspectHtml(PHISHING).signals;
  assert.deepEqual(decideModeration(standing, signals, "off"), {
    hold: null,
    notify: false,
  });
  assert.equal(decideModeration(standing, signals, "flagged").hold, "suspicious");
  assert.equal(decideModeration(standing, [], "new-accounts").hold, "new-account");
});

test("a waiting link shows recipients the review screen only; the owner still sees the work", async () => {
  config.SHARE_MODERATION = "new-accounts";
  const owner = await signedUp(0);
  const link = await sharedLink(owner, HONEST, "Секретный план");
  assert.equal(link.moderation, "held");
  const resolved = await resolve(link.token);
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.deepEqual(resolved.json(), { review: true });
  assert.doesNotMatch(resolved.body, /Секретный план|Квартальный/);
  // No grant was issued for the recipient.
  const grants = await db.query("SELECT 1 FROM grants WHERE share_id=$1", [
    link.shareId,
  ]);
  assert.equal(grants.rowCount, 0);
  // The owner's shelf says the link is under review and shows the work.
  const mine = await call("GET", `/api/artifacts/${link.artifactId}`, undefined, owner.cookie);
  assert.equal(mine.json().share.moderation, "held");
  assert.equal(mine.json().title, "Секретный план");
  const document = await app.inject({
    url: `/api/revisions/${link.revisionId}/document`,
    headers: { cookie: owner.cookie, "sec-fetch-dest": "iframe" },
  });
  assert.equal(document.statusCode, 200);
  assert.match(document.body, /Квартальный отчёт/);
  // A paused link looks the same to a recipient.
  await db.query("UPDATE shares SET moderation='paused' WHERE id=$1", [
    link.shareId,
  ]);
  assert.deepEqual((await resolve(link.token)).json(), { review: true });
  // An ordinary link tells the recipient who published it, never by name.
  config.SHARE_MODERATION = "off";
  const open = await sharedLink(owner, HONEST);
  const view = (await resolve(open.token)).json();
  assert.equal(view.publisher, "user");
  assert.equal(view.authorIsNew, true);
  assert.equal(typeof view.grant, "string");
  assert.doesNotMatch(JSON.stringify(view), new RegExp(owner.id));
  assert.doesNotMatch(JSON.stringify(view), /example\.test|email-/);
  const veteran = await signedUp(10);
  const settled = (await resolve((await sharedLink(veteran, HONEST)).token)).json();
  assert.equal(settled.authorIsNew, false);
});

test("reports: every report is a letter; N distinct reporters pause the link; the same reporter counts once", async () => {
  config.MODERATION_AUTOPAUSE_REPORTS = 3;
  const owner = await operatorCreated();
  const link = await sharedLink(owner, HONEST);
  const report = (ip: string, comment?: string) =>
    app.inject({
      method: "POST",
      url: "/api/reports",
      remoteAddress: ip,
      headers: { origin },
      payload: {
        key: randomUUID(),
        token: link.token,
        reason: "phishing",
        ...(comment ? { comment } : {}),
      },
    });
  const [a, b, c] = [address(), address(), address()];
  assert.equal((await report(a, "Похоже на банк")).statusCode, 200);
  assert.equal((await report(a)).statusCode, 200);
  assert.equal((await report(b)).statusCode, 200);
  assert.equal((await shareRow(link.shareId)).moderation, "none");
  const reporters = await db.query(
    "SELECT count(DISTINCT reporter_hash)::int AS n, count(*)::int AS total FROM share_reports WHERE share_id=$1",
    [link.shareId],
  );
  assert.deepEqual(reporters.rows[0], { n: 2, total: 3 });
  // No address is stored, only the per-link hash.
  const stored = JSON.stringify(
    (await db.query("SELECT * FROM share_reports WHERE share_id=$1", [link.shareId])).rows,
  );
  assert.ok(!stored.includes(a) && !stored.includes(b));
  assert.equal((await report(c)).statusCode, 200);
  const paused = await shareRow(link.shareId);
  assert.equal(paused.moderation, "paused");
  assert.equal(paused.moderation_reason, "reports");
  assert.deepEqual((await resolve(link.token)).json(), { review: true });
  assert.equal((await authorStanding(db, owner.tenant)).trusted, false);
  const mail = await letters(link.shareId, 4);
  assert.equal(mail.length, 4);
  assert.ok(mail.every((letter) => letter.to === "operator@example.test"));
  assert.equal(
    mail.filter((letter) => /жалоба на ссылку/.test(letter.subject)).length,
    3,
  );
  const pause = mail.find((letter) => /приостановлена/.test(letter.subject));
  assert.ok(pause);
  assert.match(pause.text, /Разных жалобщиков за 7 дней: 3/);
  // «Снять паузу» from the letter reopens the link and restores trust.
  const lift = await moderation("act", button(pause, "Снять паузу"));
  assert.equal(lift.statusCode, 200, lift.body);
  assert.equal(lift.json().changed, true);
  assert.equal((await shareRow(link.shareId)).moderation, "none");
  assert.equal((await authorStanding(db, owner.tenant)).trusted, true);
  assert.equal(typeof (await resolve(link.token)).json().grant, "string");
});

test("operator letter: GET and inspect change nothing, POST acts once, a repeat is harmless", async () => {
  config.SHARE_MODERATION = "flagged";
  const owner = await signedUp(0);
  const link = await sharedLink(owner, PHISHING, "Вход в банк");
  assert.equal(link.moderation, "held");
  const [letter] = await letters(link.shareId);
  assert.ok(letter, "held letter written in MAIL_MODE=local");
  assert.match(letter.subject, /ссылка ждёт проверки/);
  assert.match(letter.text, /Вход в банк/);
  // The letter names the account, never its e-mail address.
  assert.match(letter.text, /аккаунт email-[0-9a-f-]{36} \(регистрация по почте\)/);
  assert.doesNotMatch(letter.text + letter.html, /@example\.test/);
  assert.match(letter.text, /похоже на фишинг/);
  assert.match(letter.text, /номер карты/);
  assert.match(letter.text, /Сбер/);
  assert.match(letter.html, /Одобрить и доверять автору/);
  const approve = button(letter, "Одобрить ссылку");
  assert.ok(verifyModerationToken(approve));

  // Mail scanners open links: the page itself is only the SPA shell.
  const root = await mkdtemp(join(tmpdir(), "polka-moderation-"));
  const web = await createApp();
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<html><body>Polka shell</body></html>");
    await registerFrontend(web, root);
    await web.ready();
    const page = await web.inject(`/moderation#${approve}`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Polka shell/);
    assert.equal((await web.inject({ method: "HEAD", url: "/moderation" })).statusCode, 200);
  } finally {
    await web.close();
    await rm(root, { recursive: true, force: true });
  }
  const inspected = await moderation("inspect", approve);
  assert.equal(inspected.statusCode, 200, inspected.body);
  assert.equal(inspected.json().action, "approve");
  assert.equal(inspected.json().share.state, "held");
  assert.match(inspected.json().author.label, /@example\.test/);
  // The preview works while the link is held, with the recipient's grant.
  const preview = await moderation("preview", button(letter, "Посмотреть"));
  assert.equal(preview.statusCode, 200, preview.body);
  const viewed = await app.inject({
    url: `/api/view/${preview.json().grant}/document`,
    headers: { "sec-fetch-dest": "iframe" },
  });
  assert.equal(viewed.statusCode, 200);
  assert.match(viewed.body, /Номер карты/);
  // Nothing of that changed the link.
  const before = await shareRow(link.shareId);
  assert.equal(before.moderation, "held");
  assert.deepEqual((await resolve(link.token)).json(), { review: true });
  // A GET to the action endpoint does not exist.
  assert.equal(
    (await app.inject({ method: "GET", url: `/api/moderation/act?token=${approve}` })).statusCode,
    404,
  );
  assert.equal((await shareRow(link.shareId)).moderation, "held");

  const first = await moderation("act", approve);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().changed, true);
  assert.equal((await shareRow(link.shareId)).moderation, "none");
  const again = await moderation("act", approve);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().changed, false);
  assert.equal(typeof (await resolve(link.token)).json().grant, "string");
  // A preview token never acts.
  assert.equal((await moderation("act", button(letter, "Посмотреть"))).statusCode, 400);
});

test("approve and trust: the author's next links open without review; close-disable is idempotent", async () => {
  config.SHARE_MODERATION = "new-accounts";
  const owner = await signedUp(0);
  const link = await sharedLink(owner, HONEST);
  assert.equal(link.moderation, "held");
  const [letter] = await letters(link.shareId);
  const trust = await moderation("act", button(letter, "Одобрить и доверять автору"));
  assert.equal(trust.statusCode, 200, trust.body);
  assert.match(trust.json().message, /доверенный/);
  assert.ok((await db.query("SELECT trusted_at FROM accounts WHERE id=$1", [owner.id])).rows[0].trusted_at);
  const next = await sharedLink(owner, HONEST);
  assert.equal(next.moderation, "none");

  const other = await signedUp(0);
  const bad = await sharedLink(other, HONEST);
  const [badLetter] = await letters(bad.shareId);
  const disable = button(badLetter, "Закрыть и отключить автора");
  const first = await moderation("act", disable);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().changed, true);
  assert.equal((await shareRow(bad.shareId)).revoked, true);
  assert.equal(
    (await db.query("SELECT disabled FROM accounts WHERE id=$1", [other.id])).rows[0].disabled,
    true,
  );
  const second = await moderation("act", disable);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().changed, false);
  const close = await moderation("act", button(badLetter, "Закрыть ссылку"));
  assert.equal(close.statusCode, 200, close.body);
  assert.equal(close.json().changed, false);
});

test("forged, altered and expired moderation tokens are refused", async () => {
  const owner = await operatorCreated();
  const link = await sharedLink(owner, HONEST);
  const good = signModerationToken("close", link.shareId);
  const [payload, signature] = good.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({ v: 1, a: "close", s: randomUUID(), e: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  const otherKey = createHmac(
    "sha256",
    createHmac("sha256", "x".repeat(64)).update("polka/moderation-action/v1").digest(),
  )
    .update(payload)
    .digest("base64url");
  // Flip the first character: the last one of a 43-char base64url HMAC
  // carries padding bits, so A and B there decode to the same bytes.
  const flipped = (signature.startsWith("A") ? "B" : "A") + signature.slice(1);
  for (const token of [
    `${forgedPayload}.${signature}`,
    `${payload}.${otherKey}`,
    `${payload}.${flipped}`,
    signModerationToken("close", link.shareId, Date.now() - 8 * 24 * 3600 * 1000),
    "",
    "not-a-token",
  ]) {
    for (const path of ["inspect", "act", "preview"]) {
      const response = await moderation(path, token);
      assert.equal(response.statusCode, 403, `${path} ${token.slice(0, 20)}`);
      assert.match(response.json().message, /7 дней/);
    }
  }
  assert.equal((await shareRow(link.shareId)).revoked, false);
  // Six days later a token still works.
  const recent = signModerationToken("close", link.shareId, Date.now() - 6 * 24 * 3600 * 1000);
  assert.equal((await moderation("inspect", recent)).statusCode, 200);
  // Without a Полка Origin the browser POST is refused before the token is read.
  const foreign = await app.inject({
    method: "POST",
    url: "/api/moderation/act",
    headers: { origin: "https://evil.example" },
    payload: { token: good },
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal((await shareRow(link.shareId)).revoked, false);
});

test("agents are told when a link waits, and a new account's link is shortened to 7 days", async () => {
  config.SHARE_MODERATION = "new-accounts";
  const owner = await signedUp(0);
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'abuse test',$5,$6,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(secret), ["context", "capture", "share"], MCP_AUDIENCE],
  );
  const publish = await app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress: address(),
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    payload: JSON.stringify({ key: randomUUID(), title: "Отчёт агента", html: HONEST }),
  });
  assert.equal(publish.statusCode, 200, publish.body);
  const body = publish.json();
  publishResponseSchema.parse(body);
  assert.equal(body.state, "shared");
  assert.equal(body.moderation, "held");
  assert.match(body.moderationMessage, /на проверке у модератора Полки/);
  assert.match(body.expiresNote, /на 7 дней вместо 30/);
  const days = (new Date(body.expiresAt).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7.01, String(days));
  // An ordinary answer keeps its shape.
  config.SHARE_MODERATION = "off";
  const plain = await app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress: address(),
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    payload: JSON.stringify({ key: randomUUID(), title: "Второй", html: HONEST, expiresInDays: 7 }),
  });
  assert.equal(plain.statusCode, 200, plain.body);
  assert.equal("moderation" in plain.json(), false);
});

test("phishing signals: obvious fakes are flagged, honest pages are not", () => {
  const flagged = (html: string) => isSuspicious(inspectHtml(html).signals);
  assert.equal(flagged(PHISHING), true);
  assert.deepEqual(
    inspectHtml(PHISHING).signals.filter((s) => s.startsWith("secret:")),
    ["secret:card-number", "secret:sms-code"],
  );
  assert.equal(
    flagged(
      '<p>Your Apple ID has been suspended.</p><input aria-label="Password" autocomplete="current-password">',
    ),
    true,
  );
  assert.equal(
    flagged('<h1>Госуслуги</h1><p>Введите одноразовый код</p><input id="otp_code">'),
    true,
  );
  // An interactive page: the fields live in script strings.
  assert.equal(
    flagged(
      `<div id="root"></div><script>const f=document.createElement("input");f.placeholder="Пароль от Тинькофф";document.body.append(f)</script>`,
    ),
    true,
  );
  const jsx = new SignalCollector();
  scanScript(
    `export default function App(){return <main>\n  <h1>Т-Банк</h1>\n  <p>Аккаунт заблокирован</p>\n  <input placeholder="Код из SMS" />\n</main>}`,
    jsx,
  );
  assert.equal(isSuspicious(jsx.list()), true, jsx.list().join());

  // Honest pages that must stay unflagged.
  assert.equal(
    flagged(
      "<h1>Вклады: Сбер, ВТБ, Т-Банк, Альфа-Банк</h1><p>Срочно успейте до конца месяца: ставки снижаются. Никогда не сообщайте пароль и код из SMS.</p>",
    ),
    false,
  );
  assert.equal(
    flagged(
      '<h2>Регистрация</h2><label>Почта <input name="email"></label><label>Пароль <input name="password"></label><label>Подтвердите пароль <input name="password_confirm"></label>',
    ),
    false,
  );
  assert.equal(
    flagged(
      "<h1>Генератор паролей</h1><script>const label='password strength';const charset='abcdef0123';</script><p>Сбережения храните в надёжном месте.</p>",
    ),
    false,
  );
  assert.equal(
    flagged(
      "<p>Пример из документации Google:</p><pre>&lt;input type=\"password\" name=\"password\"&gt;</pre>",
    ),
    false,
  );
});

test("signals of a large page come back from the bounded worker; an unreadable page counts as suspicious", async () => {
  const padding = `<p>${"Обычный абзац текста страницы. ".repeat(1_000)}</p>`;
  const large = PHISHING.replace("</body>", `${padding}</body>`);
  assert.ok(large.length > 16 * 1024);
  const read = await inspectHtmlBounded(large);
  assert.equal(read.profile, "static");
  assert.equal(isSuspicious(read.signals), true, read.signals.join());
  const honest = await inspectHtmlBounded(HONEST.replace("</body>", `${padding}</body>`));
  assert.equal(isSuspicious(honest.signals), false, honest.signals.join());
  // Deep nesting cannot hide a page from the check: past the deadline it is
  // "unsupported" (no static link) and suspicious (a live link would wait).
  const nested = await inspectHtmlBounded("<div>".repeat(200_000), 1_000);
  assert.deepEqual(nested, { profile: "unsupported", signals: [SCAN_INCOMPLETE] });
  assert.equal(isSuspicious(nested.signals), true);
});

test("the phishing scan stays linear in the page size", () => {
  // Saving runs this on the request thread, like classifyHtml (see unit.test.ts).
  const MB = 1024 * 1024;
  const pages = [
    "номер ".repeat(MB / 6),
    `<p>${"подтвердите ".repeat(MB / 12)}</p>`,
    `<input name="${"номер ".repeat(MB / 6)}">`,
    `<input placeholder="${"код из ".repeat(MB / 7)}">`,
    `<script>${"'\\".repeat(MB / 2)}</script>`,
    `<script>${">a".repeat(MB / 2)}</script>`,
    `<script>${"/*".repeat(MB / 2)}</script>`,
    `<script>${"`${".repeat(MB / 3)}</script>`,
    "<p>" + "сбер".repeat(MB / 4) + "</p>",
  ];
  for (const page of pages) {
    const started = performance.now();
    inspectHtml(page);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2_000, `${JSON.stringify(page.slice(0, 16))}: ${Math.round(elapsed)} ms`);
  }
  for (const source of [">".repeat(MB), "'".repeat(MB), "a>b<".repeat(MB / 4)]) {
    const started = performance.now();
    scanScript(source, new SignalCollector());
    assert.ok(performance.now() - started < 2_000);
  }
});
