// Acting on the content filter (docs/specs/CONTENT_FILTER.md): blocks at save
// and at share, isolation and deletion by category, the SHA-256 stop list,
// the journal, operator blocks and takedowns, the model stage (fake models),
// comments, anti-spam, urgent reports and automatic moderation.
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { LOCAL_OPERATOR_MAIL_DIRECTORY } from "../apps/server/mailer.ts";
import { bucket, readBlob, s3, sha256 } from "../apps/server/storage.ts";
import {
  purgeBlock,
  purgeDueBlocks,
  remindDueBlocks,
  resetRetention,
  reviewsSettled,
} from "../apps/server/content-moderation.ts";
import {
  setContentModels,
  type ModelAnswer,
  type ModelClient,
} from "../apps/server/content-filter/model.ts";
import { setCodeReviewer } from "../apps/server/content-filter/code-model.ts";
import {
  formatTakedown,
  listEvents,
  setLegalHold,
  takedown,
  unblock,
} from "../apps/server/moderation.ts";
import { signModerationToken } from "../apps/server/moderation-tokens.ts";
import {
  createSharedComment,
  sharedComments,
  type Viewer,
} from "../apps/server/comments.ts";
import { beginEmailLogin } from "../apps/server/email-auth.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
if (config.MAIL_MODE !== "local")
  throw new Error("Content-moderation tests read operator letters from local mail");
const defaults = { ...config };
config.OPERATOR_EMAIL = "operator@example.test";

afterEach(() => {
  for (const key of [
    "SHARE_MODERATION",
    "CONTENT_FILTER_MODE",
    "CONTENT_FILTER_AUTOBLOCK",
    "MODERATION_RETENTION",
    "NEW_ACCOUNT_DAILY_LINKS",
    "NEW_ACCOUNT_MAX_LINKS",
    "EMAIL_SIGNUP_DAILY_PER_SUBNET",
    "CONTENT_MODEL_DAILY_BUDGET_RUB",
    "OPERATOR_CONTACT",
  ] as const)
    (config as any)[key] = (defaults as any)[key];
  resetRetention();
  setContentModels(undefined);
  setCodeReviewer(undefined);
});

after(async () => {
  await reviewsSettled();
  await new Promise((resolve) => setTimeout(resolve, 300));
  config.OPERATOR_EMAIL = defaults.OPERATOR_EMAIL;
  await app.close();
  await db.end();
  s3.destroy();
});

const address = () =>
  `2001:db8:c::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

type Owner = { id: string; tenant: string; cookie: string };

async function session(accountId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [sha256(token), accountId],
  );
  return `polka_session=${token}`;
}

async function signedUp(ageDays = 0): Promise<Owner> {
  const id = randomUUID(),
    tenant = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,name,password_hash,email,created_at,display_name)
     VALUES($1,$2,'unused',$3,now()-$4*interval '1 day','Читатель')`,
    [id, `email-${id}`, `cf-${id.slice(0, 8)}@example.test`, ageDays],
  );
  await db.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [tenant, id]);
  return { id, tenant, cookie: await session(id) };
}

async function trusted(): Promise<Owner> {
  const owner = await signedUp(0);
  await db.query("UPDATE accounts SET trusted_at=now() WHERE id=$1", [owner.id]);
  return owner;
}

async function operatorCreated(): Promise<Owner> {
  const created = await createAccount(
    `cf-${randomBytes(4).toString("hex")}`,
    randomBytes(24).toString("hex"),
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

async function upload(owner: Owner, content: string | Buffer, mime = "text/html", title = "Страница") {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const begin = await call(
    "POST",
    "/api/uploads",
    {
      key: randomUUID(),
      title,
      filename: mime === "text/html" ? "page.html" : mime === "text/plain" ? "a.txt" : "a.png",
      mime,
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
    headers: { origin, cookie: owner.cookie, "content-type": "application/octet-stream" },
    payload: bytes,
  });
  assert.equal(put.statusCode, 200, put.body);
  return call("POST", `/api/uploads/${uploadId}/finalize`, {}, owner.cookie);
}

async function save(owner: Owner, content: string | Buffer, mime = "text/html", title?: string) {
  const done = await upload(owner, content, mime, title);
  assert.equal(done.statusCode, 200, done.body);
  return done.json() as { artifactId: string; revisionId: string };
}

async function share(owner: Owner, receipt: { artifactId: string; revisionId: string }) {
  return call(
    "POST",
    `/api/artifacts/${receipt.artifactId}/share`,
    { expectedRevisionId: receipt.revisionId, expiresInDays: 7 },
    owner.cookie,
  );
}

async function sharedLink(owner: Owner, html: string, title?: string) {
  const receipt = await save(owner, html, "text/html", title);
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

const page = (body: string, title = "Страница") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const HONEST = page(`<h1>Отчёт</h1><p>${"Выручка выросла на 12%, расходы стабильны. ".repeat(4)}</p>`);
const DRUGS = page("<p>Мефедрон, альфа-пвп — купить с доставкой! Закладки по всему городу, в наличии, оптом. Прайс в боте.</p>");
const CSAM = page("<p>Скачать детское порно бесплатно, архив pthc, смотреть</p>", "Архив");
const GAMBLING = page("<p>Онлайн казино Вулкан: фриспины за регистрацию, бонус на депозит, рабочее зеркало. Играть на деньги!</p>");

type Letter = { to: string; subject: string; text: string; html?: string };
async function lettersWith(needle: string, count = 1) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found: Letter[] = [];
    try {
      for (const name of (await readdir(LOCAL_OPERATOR_MAIL_DIRECTORY)).sort()) {
        const letter = JSON.parse(
          await readFile(join(LOCAL_OPERATOR_MAIL_DIRECTORY, name), "utf8"),
        ) as Letter;
        if (letter.text.includes(needle)) found.push(letter);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (found.length >= count || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const row = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0];
const versionsOf = async (prefix: string) => {
  const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
  return (listed.Versions?.length ?? 0) + (listed.DeleteMarkers?.length ?? 0);
};

test("CSAM at save: blocked and isolated at once, the author disabled, the letter without content", async () => {
  const owner = await signedUp(0);
  const receipt = await save(owner, CSAM);
  const account = await row("SELECT disabled FROM accounts WHERE id=$1", [owner.id]);
  assert.equal(account.disabled, true);
  const block = await row("SELECT * FROM moderation_blocks WHERE revision_id=$1", [receipt.revisionId]);
  assert.equal(block.category, "csam");
  assert.equal(block.isolated, true);
  // Kept 90 days as evidence, then deleted.
  const days = (new Date(block.delete_after).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 89 && days < 91, String(days));
  // Nobody reads it, the owner and the server included.
  const revision = await row("SELECT object_key,object_version FROM revisions WHERE id=$1", [receipt.revisionId]);
  await assert.rejects(readBlob(revision.object_key, revision.object_version), (error: any) => error.status === 410);
  // The journal: what and why, never the content.
  const events = await listEvents(receipt.revisionId);
  assert.ok(events.some((event) => event.action === "revision.blocked" && event.category === "csam"));
  assert.doesNotMatch(JSON.stringify(events), /порно|pthc|Архив/);
  const [letter] = await lettersWith(receipt.revisionId);
  assert.ok(letter, "no letter");
  assert.match(letter.subject, /CSAM/);
  assert.doesNotMatch(letter.text, /Архив|порно|pthc|moderation#/);
  // The same bytes again, by anyone: blocked at once as well.
  const other = await signedUp(0);
  const again = await save(other, CSAM);
  assert.equal((await row("SELECT disabled FROM accounts WHERE id=$1", [other.id])).disabled, true);
  assert.ok(await row("SELECT 1 FROM moderation_blocks WHERE revision_id=$1", [again.revisionId]));
});

test("honest pages open; a severe category waits for any author; the letter names terms", async () => {
  const author = await trusted();
  const honest = await sharedLink(author, HONEST);
  assert.equal(honest.moderation, "none");
  const drugs = await sharedLink(author, DRUGS);
  assert.equal(drugs.moderation, "held");
  assert.equal((await row("SELECT moderation_reason FROM shares WHERE id=$1", [drugs.shareId])).moderation_reason, "content:drugs");
  const resolved = await call("POST", "/api/resolve", { token: drugs.token });
  assert.deepEqual(resolved.json(), { review: true });
  const [letter] = await lettersWith(drugs.shareId);
  assert.match(letter.text, /наркотики/);
  assert.match(letter.text, /купить/);
  assert.match(letter.text, /Заблокировать: /);
  const events = await listEvents(drugs.shareId);
  assert.ok(events.some((event) => event.action === "share.held" && event.category === "drugs"));
});

test("the operator blocks from the letter with a legal hold; recipients, owner and re-saves are refused; deletion after the hold", async () => {
  const owner = await trusted();
  config.OPERATOR_CONTACT = "privacy@polochka.app";
  const link = await sharedLink(owner, DRUGS);
  const token = signModerationToken("block", link.shareId);
  const inspect = await call("POST", "/api/moderation/inspect", { token });
  assert.equal(inspect.statusCode, 200, inspect.body);
  assert.match(inspect.json().share.content, /наркотики/);
  const act = await call("POST", "/api/moderation/act", {
    token,
    legalHold: true,
    authority: "МВД, запрос №1",
  });
  assert.equal(act.statusCode, 200, act.body);
  assert.equal(act.json().changed, true);
  assert.deepEqual((await call("POST", "/api/resolve", { token: link.token })).json(), { blocked: true });
  const shelf = await call("GET", `/api/artifacts/${link.artifactId}`, undefined, owner.cookie);
  assert.equal(shelf.json().share.moderation, "blocked");
  assert.equal(shelf.json().share.appeal, "privacy@polochka.app");
  // No new link to the blocked version, and the same bytes cannot be saved again.
  const again = await share(owner, link);
  assert.equal(again.statusCode, 403, again.body);
  const resave = await upload(await signedUp(0), DRUGS);
  assert.equal(resave.statusCode, 403, resave.body);
  assert.match(resave.json().message, /заблокирован/);
  // Isolated (drugs: 90 days), kept by the legal hold even when due.
  const block = await row("SELECT * FROM moderation_blocks WHERE revision_id=$1", [link.revisionId]);
  assert.equal(block.legal_hold, "МВД, запрос №1");
  await db.query("UPDATE moderation_blocks SET delete_after=now()-interval '1 minute' WHERE id=$1", [block.id]);
  assert.equal((await purgeBlock(block.id)).purged, false);
  const revision = await row("SELECT object_key FROM revisions WHERE id=$1", [link.revisionId]);
  assert.ok((await versionsOf(revision.object_key)) > 0);
  // Lifting the hold deletes every version; the row stays as a tombstone.
  await setLegalHold(link.revisionId, "", false);
  assert.equal(await versionsOf(revision.object_key), 0);
  const tombstone = await row("SELECT sha256,content_purged_at FROM revisions WHERE id=$1", [link.revisionId]);
  assert.ok(tombstone.content_purged_at);
  assert.equal(tombstone.sha256, sha256(DRUGS));
  const events = await listEvents(link.revisionId);
  assert.ok(events.some((event) => event.action === "content.deleted"));
  assert.ok(events.some((event) => event.actor === "operator-mail" && event.action === "revision.blocked"));
});

test("soft categories close links but the owner keeps the work; unblock reopens it", async () => {
  const owner = await trusted();
  const link = await sharedLink(owner, HONEST.replace("Отчёт", "Отчёт о казино"));
  const receipt = await takedown(link.shareId, {
    reason: "реклама казино",
    category: "gambling",
    authority: "Роскомнадзор, требование №42",
  });
  assert.equal(receipt.blocked.length, 1);
  const text = formatTakedown(receipt);
  assert.match(text, /КВИТАНЦИЯ/);
  assert.match(text, /Роскомнадзор, требование №42/);
  assert.match(text, /у владельца она остаётся/);
  assert.deepEqual((await call("POST", "/api/resolve", { token: link.token })).json(), { blocked: true });
  const bytes = await call("GET", `/api/revisions/${link.revisionId}/bytes`, undefined, owner.cookie);
  assert.equal(bytes.statusCode, 200, bytes.body);
  await unblock(link.revisionId, "ошибка");
  const reopened = await call("POST", "/api/resolve", { token: link.token });
  assert.ok(reopened.json().grant, reopened.body);
  const events = await listEvents(link.revisionId);
  assert.ok(events.some((event) => event.action === "block.released"));
  assert.ok((await listEvents()).some((event) => event.action === "takedown" && event.authority === "Роскомнадзор, требование №42"));
});

test("retention: a reminder the day before, deletion when due; the journal is append-only", async () => {
  config.MODERATION_RETENTION = "porn=30";
  resetRetention();
  const owner = await trusted();
  const link = await sharedLink(owner, HONEST.replace("Отчёт", "Отчёт 2"));
  await takedown(link.shareId, { reason: "порнография по жалобе", category: "porn" });
  const block = await row("SELECT * FROM moderation_blocks WHERE revision_id=$1", [link.revisionId]);
  await db.query("UPDATE moderation_blocks SET delete_after=now()+interval '12 hours' WHERE id=$1", [block.id]);
  assert.ok((await remindDueBlocks()) >= 1);
  const reminder = (await lettersWith(link.revisionId, 2)).find((letter) =>
    /завтра удаляется/.test(letter.subject),
  );
  assert.ok(reminder, "no reminder");
  await db.query("UPDATE moderation_blocks SET delete_after=now()-interval '1 second' WHERE id=$1", [block.id]);
  assert.ok((await purgeDueBlocks()) >= 1);
  assert.ok((await row("SELECT purged_at FROM moderation_blocks WHERE id=$1", [block.id])).purged_at);
  const event = (await listEvents(link.revisionId))[0]!;
  await assert.rejects(db.query("DELETE FROM moderation_events WHERE id=$1", [event.id]), /kept for 3 years/);
  await assert.rejects(db.query("UPDATE moderation_events SET reason='x' WHERE id=$1", [event.id]), /append-only/);
});

test("malicious code: a miner is blocked at save and isolated for 30 days", async () => {
  const owner = await trusted();
  const receipt = await save(owner, page(`<script>var miner = new CoinHive.Anonymous("site-key"); miner.start();</script><p>Игра</p>`));
  const block = await row("SELECT * FROM moderation_blocks WHERE revision_id=$1", [receipt.revisionId]);
  assert.equal(block.category, "malicious_code");
  assert.equal(block.isolated, true);
  const days = (new Date(block.delete_after).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 29 && days < 31);
  // Balanced mode: the author is not disabled for code.
  assert.equal((await row("SELECT disabled FROM accounts WHERE id=$1", [owner.id])).disabled, false);
});

test("strict with autoblock: a severe category at its high score blocks at save and disables the author", async () => {
  config.CONTENT_FILTER_MODE = "strict";
  config.CONTENT_FILTER_AUTOBLOCK = true;
  const owner = await trusted();
  const receipt = await save(owner, DRUGS.replace("Прайс", "Прайс, мефедрон за грамм, клад"));
  assert.ok(await row("SELECT 1 FROM moderation_blocks WHERE revision_id=$1", [receipt.revisionId]));
  assert.equal((await row("SELECT disabled FROM accounts WHERE id=$1", [owner.id])).disabled, true);
  // Without autoblock the same page only waits.
  config.CONTENT_FILTER_AUTOBLOCK = false;
  const other = await trusted();
  const link = await sharedLink(other, DRUGS.replace("Прайс", "Прайс, гашиш за грамм"));
  assert.equal(link.moderation, "held");
});

// Fake models: `answers` maps a marker in the text to each model's category.
function fakeModel(name: string, answer: (text: string) => string): ModelClient {
  return {
    name,
    async classify(input) {
      const category = answer(input.text ?? "");
      if (category === "fail") return { failed: "timeout", model: name, costRub: 0 };
      return { category: category as any, reason: "тест", model: name, costRub: 0.5 };
    },
  };
}

test("models: reviewed after save; agreement holds, one model only asks, CSAM waits hidden; failures stay unchecked", async () => {
  const primary = fakeModel("primary", (text) =>
    text.includes("СИГНАЛ-А") ? "drugs" : text.includes("СИГНАЛ-Б") ? "gambling" : text.includes("СИГНАЛ-В") ? "csam" : text.includes("СИГНАЛ-Г") ? "fail" : "none",
  );
  const fallback = fakeModel("fallback", (text) =>
    text.includes("СИГНАЛ-А") ? "drugs" : text.includes("СИГНАЛ-Г") ? "fail" : "none",
  );
  setContentModels({ primary, fallback });
  const owner = await trusted();
  const agreed = await sharedLink(owner, page("<p>Невинный текст СИГНАЛ-А про садоводство.</p>"));
  const single = await sharedLink(owner, page("<p>Невинный текст СИГНАЛ-Б про садоводство.</p>"));
  const csam = await sharedLink(owner, page("<p>Невинный текст СИГНАЛ-В про садоводство.</p>"));
  const failed = await sharedLink(owner, page("<p>Невинный текст СИГНАЛ-Г про садоводство.</p>"));
  // The rules found nothing; the models answer after the save (here often
  // before the link is made), and a link is decided again when they do.
  await reviewsSettled();
  const state = async (shareId: string) => (await row("SELECT moderation FROM shares WHERE id=$1", [shareId])).moderation;
  assert.equal(await state(agreed.shareId), "held");
  assert.equal(await state(single.shareId), "none");
  assert.equal(await state(csam.shareId), "held");
  assert.equal(await state(failed.shareId), "none");
  const stored = await row("SELECT content_filter->'model' AS model FROM revisions WHERE id=$1", [failed.revisionId]);
  assert.equal(stored.model.state, "unchecked");
  const [letter] = await lettersWith(single.shareId);
  assert.match(letter.text, /одна модель/);
  // A re-save of the same text: the verdict is reused, no new calls.
  let calls = 0;
  setContentModels({
    primary: { name: "counting", classify: async (input) => (calls++, primary.classify(input)) },
    fallback,
  });
  await save(owner, page("<p>Невинный текст СИГНАЛ-А про садоводство.</p>"));
  await reviewsSettled();
  assert.equal(calls, 0);
});

test("models with autoblock: both agreeing on a severe category block; the budget stops the calls", async () => {
  config.CONTENT_FILTER_AUTOBLOCK = true;
  const agree = fakeModel("m", (text) => (text.includes("СИГНАЛ-Д") ? "extremism_terror" : "none"));
  setContentModels({ primary: agree, fallback: agree });
  const owner = await trusted();
  // A link made first is blocked when the models answer…
  const early = await save(owner, page("<p>Текст СИГНАЛ-Д, первый.</p>"));
  await reviewsSettled();
  const refused = await share(owner, early);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.ok(await row("SELECT 1 FROM moderation_blocks WHERE revision_id=$1", [early.revisionId]));
  // …and a link made before they answer is blocked afterwards.
  setContentModels({ primary: { name: "slow", classify: async (input) => (await new Promise((r) => setTimeout(r, 300)), agree.classify(input)) }, fallback: agree });
  const later = await sharedLink(owner, page("<p>Текст СИГНАЛ-Д, второй.</p>"));
  await reviewsSettled();
  assert.equal((await row("SELECT moderation FROM shares WHERE id=$1", [later.shareId])).moderation, "blocked");
  // Out of budget: one letter, then rules only.
  config.CONTENT_MODEL_DAILY_BUDGET_RUB = 0.5;
  setContentModels({ primary: agree, fallback: agree });
  await save(owner, page("<p>Первый текст.</p>"));
  await reviewsSettled();
  const [letter] = await lettersWith("CONTENT_MODEL_DAILY_BUDGET_RUB");
  assert.ok(letter);
});

test("comments: a severe one waits, spam is seen only by its author, CSAM is blocked and its author disabled", async () => {
  const owner = await operatorCreated();
  const link = await sharedLink(owner, HONEST);
  const writer = await signedUp(0);
  const viewer: Viewer = { id: writer.id, name: "Читатель", tenant: writer.tenant };
  const held = await createSharedComment(link.token, viewer, { body: "Мефедрон купить с доставкой, закладки в наличии, оптом", displayName: "Читатель" });
  const ownerView: Viewer = { id: owner.id, name: "owner", tenant: owner.tenant };
  const other = await signedUp(0);
  const otherView: Viewer = { id: other.id, name: "x", tenant: other.tenant };
  const bodies = async (viewerOf: Viewer) =>
    JSON.stringify(await sharedComments(link.token, viewerOf));
  assert.doesNotMatch(await bodies(otherView), /Мефедрон/);
  assert.match(await bodies(ownerView), /Мефедрон/);
  // The same text on three links: spam, visible to its author only.
  const text = "Лучшие окна в городе, звоните прямо сейчас, скидки для всех!";
  for (const html of [HONEST.replace("Отчёт", "А"), HONEST.replace("Отчёт", "Б")]) {
    const extra = await sharedLink(owner, html);
    await createSharedComment(extra.token, viewer, { body: text, displayName: "Читатель" });
  }
  await createSharedComment(link.token, viewer, { body: text, displayName: "Читатель" });
  assert.doesNotMatch(await bodies(ownerView), /Лучшие окна/);
  assert.match(await bodies(viewer), /Лучшие окна/);
  const csamWriter = await signedUp(0);
  await createSharedComment(link.token, { id: csamWriter.id, name: "y", tenant: csamWriter.tenant }, { body: "Скачать детское порно бесплатно, архив pthc", displayName: "Y" });
  assert.equal((await row("SELECT disabled FROM accounts WHERE id=$1", [csamWriter.id])).disabled, true);
  assert.doesNotMatch(await bodies(ownerView), /pthc/);
  assert.ok(held.id);
});

test("anti-spam: throwaway mail and per-network sign-ups; the same content from three accounts; a daily link cap", async () => {
  // Local mail accepts only .test addresses, so the guards are checked
  // directly: a throwaway domain is refused and journaled; the per-network
  // and per-domain keys join the sign-up limits of email-auth.ts.
  const { assertNotDisposable, signupSpamKeys } = await import("../apps/server/signup-guards.ts");
  await assert.rejects(assertNotDisposable("a@mailinator.com"), /одноразовой/);
  assert.ok((await listEvents()).some((event) => event.action === "signup.refused"));
  config.EMAIL_SIGNUP_DAILY_PER_SUBNET = 4;
  (config as any).EMAIL_SIGNUP_DAILY_PER_DOMAIN = 5;
  const keys = signupSpamKeys("198.51.100.7", "a@corp.example");
  assert.deepEqual(keys.map((key) => [key.key, key.max()]), [
    ["email-signup-subnet:198.51.100.0/24", 4],
    ["email-signup-domain:corp.example", 5],
  ]);
  assert.equal(signupSpamKeys("198.51.100.7", "a@yandex.ru").length, 1);
  (config as any).EMAIL_SIGNUP_DAILY_PER_DOMAIN = 0;
  // Sign-in itself still works for an ordinary address.
  assert.ok((await beginEmailLogin(`ok-${randomUUID().slice(0, 6)}@example.test`, "198.51.100.8")).id);
  const spam = page(`<p>${"Уникальное предложение недели: окна и двери со скидкой, доставка и монтаж бесплатно. ".repeat(12)}</p>`);
  const links = [];
  for (let i = 0; i < 3; i++) links.push(await sharedLink(await signedUp(0), spam));
  const states = await Promise.all(
    links.map(async (link) => (await row("SELECT moderation,moderation_reason FROM shares WHERE id=$1", [link.shareId]))),
  );
  assert.ok(states.every((state) => state.moderation === "held"), JSON.stringify(states));
  // Shadow: to recipients the link looks missing.
  assert.equal((await call("POST", "/api/resolve", { token: links[2]!.token })).statusCode, 404);
  config.NEW_ACCOUNT_DAILY_LINKS = 2;
  config.NEW_ACCOUNT_MAX_LINKS = 0;
  const busy = await signedUp(0);
  await sharedLink(busy, HONEST.replace("Отчёт", "1"));
  await sharedLink(busy, HONEST.replace("Отчёт", "2"));
  const third = await share(busy, await save(busy, HONEST.replace("Отчёт", "3")));
  assert.equal(third.statusCode, 429, third.body);
  assert.match(third.json().message, /в сутки/);
});

test("an urgent report pauses the link at once", async () => {
  const owner = await trusted();
  const link = await sharedLink(owner, HONEST.replace("Отчёт", "Срочно"));
  const report = await call("POST", "/api/reports", { key: randomUUID(), token: link.token, reason: "threat_to_life" });
  assert.equal(report.statusCode, 200, report.body);
  assert.equal((await row("SELECT moderation FROM shares WHERE id=$1", [link.shareId])).moderation, "paused");
});

test("SHARE_MODERATION=auto: no manual review of authors; a young account's unchecked image waits; trust needs clean saves", async () => {
  config.SHARE_MODERATION = "auto";
  const young = await signedUp(0);
  const honest = await sharedLink(young, HONEST);
  assert.equal(honest.moderation, "none");
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const image = await share(young, await save(young, png, "image/png"));
  assert.equal(image.statusCode, 200, image.body);
  assert.equal(image.json().share.moderation, "held");
  // Old, no reports, but no clean saves: not trusted yet under auto.
  const old = await signedUp(30);
  const { authorStanding } = await import("../apps/server/share-moderation.ts");
  assert.equal((await authorStanding(db, old.tenant)).trusted, false);
  for (let i = 0; i < 3; i++) await save(old, HONEST.replace("Отчёт", `Сводка ${i}`));
  assert.equal((await authorStanding(db, old.tenant)).trusted, true);
});
