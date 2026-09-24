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

test("models: a rate-limited primary (429) goes to the fallback at once and uses up no attempts; a flat rate ignores the budget", async () => {
  // The review is queued after the save commits: wait for its verdict.
  const verdict = async (revisionId: string) => {
    for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
      await reviewsSettled();
      const { model } = await row("SELECT content_filter->'model' AS model FROM revisions WHERE id=$1", [revisionId]);
      if (model) return model;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("no model verdict");
  };
  const limited = (name: string): ModelClient => ({
    name,
    classify: async () => ({ failed: "rate_limited", model: name, costRub: 0 }),
  });
  let fallbackCalls = 0;
  const fallback = fakeModel("fallback", (text) => (fallbackCalls++, text.includes("СИГНАЛ-Ж") ? "drugs" : "none"));
  setContentModels({ primary: limited("primary"), fallback });
  const owner = await trusted();
  const checked = await verdict((await save(owner, page("<p>Невинный текст СИГНАЛ-Ж про садоводство.</p>"))).revisionId);
  assert.equal(fallbackCalls, 1);
  assert.equal(checked.state, "checked");
  assert.deepEqual(checked.findings.map((finding: any) => [finding.category, finding.agreed]), [["drugs", false]]);
  assert.deepEqual(checked.answers.map((answer: any) => answer.answer), ["ошибка: rate_limited", "drugs"]);
  // Both endpoints at their limits: unchecked, retried, attempts untouched.
  setContentModels({ primary: limited("primary"), fallback: limited("fallback") });
  const unchecked = await verdict((await save(owner, page("<p>Другой текст про садоводство.</p>"))).revisionId);
  assert.equal(unchecked.state, "unchecked");
  assert.equal(unchecked.attempts, 0);
  // A real failure counts.
  setContentModels({ primary: fakeModel("primary", () => "fail"), fallback: limited("fallback") });
  assert.equal((await verdict((await save(owner, page("<p>Третий текст про садоводство.</p>"))).revisionId)).attempts, 1);
  // Out of budget: a paid model is not asked, a flat-rate one still is.
  config.CONTENT_MODEL_DAILY_BUDGET_RUB = 0;
  let paidCalls = 0,
    flatCalls = 0;
  setContentModels({
    primary: { name: "paid", classify: async (input) => (paidCalls++, fallback.classify(input)) },
    fallback: null,
  });
  assert.equal((await verdict((await save(owner, page("<p>Четвёртый текст.</p>"))).revisionId)).state, "unchecked");
  assert.equal(paidCalls, 0);
  setContentModels({
    primary: {
      name: "flat",
      flatRate: true,
      classify: async () => (flatCalls++, { category: "none", reason: "", model: "flat", costRub: 0 }),
    },
    fallback: null,
  });
  assert.equal((await verdict((await save(owner, page("<p>Пятый текст.</p>"))).revisionId)).state, "checked");
  assert.equal(flatCalls, 1);
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

// ---------------------------------------------------------------------------
// Holds that wait only for the model: released when it answers clean.

/** A model that answers only when the test opens its gate. */
function gatedModel(answer: string) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const client: ModelClient = {
    name: "gated",
    async classify() {
      await gate;
      return answer === "fail"
        ? { failed: "timeout", model: "gated", costRub: 0 }
        : { category: answer as any, reason: "тест", model: "gated", costRub: 0 };
    },
  };
  return { client, open };
}

/** A distinct tiny PNG each time (the same bytes would be one material). */
const PNG = () =>
  Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"),
    randomBytes(8),
  ]);

async function imageLink(owner: Owner) {
  const receipt = await save(owner, PNG(), "image/png");
  const response = await share(owner, receipt);
  assert.equal(response.statusCode, 200, response.body);
  return { ...receipt, shareId: response.json().share.id as string };
}

const shareState = async (shareId: string) => {
  const found = await row("SELECT moderation,moderation_reason FROM shares WHERE id=$1", [shareId]);
  return { moderation: found.moderation, moderation_reason: found.moderation_reason };
};
const eventsOf = async (shareId: string, action: string) =>
  (
    await db.query(
      "SELECT actor,reason FROM moderation_events WHERE share_id=$1 AND action=$2",
      [shareId, action],
    )
  ).rows.map((event) => ({ actor: event.actor, reason: event.reason }));

test("auto: a young account's image link waits for the model and opens when it answers clean, without a letter", async () => {
  config.SHARE_MODERATION = "auto";
  const model = gatedModel("none");
  setContentModels({ primary: model.client, fallback: null });
  const young = await signedUp(0);
  const link = await imageLink(young);
  assert.deepEqual(await shareState(link.shareId), {
    moderation: "held",
    moderation_reason: "image-unchecked",
  });
  model.open();
  await reviewsSettled();
  assert.deepEqual(await shareState(link.shareId), { moderation: "none", moderation_reason: null });
  assert.deepEqual(await eventsOf(link.shareId, "share.released"), [
    { actor: "filter", reason: "image-unchecked" },
  ]);
  // The only letter about this link is the one sent when it was made.
  assert.equal((await lettersWith(link.shareId, 2)).length, 1);
});

test("auto: a model that fails keeps the image link waiting; a flag holds it for the flag; no model keeps it", async () => {
  config.SHARE_MODERATION = "auto";
  const young = await signedUp(0);
  const failing = gatedModel("fail");
  setContentModels({ primary: failing.client, fallback: null });
  const failed = await imageLink(young);
  failing.open();
  await reviewsSettled();
  assert.deepEqual(await shareState(failed.shareId), {
    moderation: "held",
    moderation_reason: "image-unchecked",
  });
  assert.equal((await eventsOf(failed.shareId, "share.released")).length, 0);
  const flagging = gatedModel("csam");
  setContentModels({ primary: flagging.client, fallback: null });
  const flagged = await imageLink(young);
  flagging.open();
  await reviewsSettled();
  assert.deepEqual(await shareState(flagged.shareId), {
    moderation: "held",
    moderation_reason: "content:csam",
  });
  assert.equal((await eventsOf(flagged.shareId, "share.released")).length, 0);
  assert.deepEqual(
    (await eventsOf(flagged.shareId, "share.held")).map((event) => event.reason).sort(),
    ["content:csam", "image-unchecked"],
  );
  // Without any model the image waits, as before.
  setContentModels(null);
  const unconfigured = await imageLink(young);
  const { reconsiderLinks } = await import("../apps/server/shares.ts");
  assert.deepEqual(
    (await reconsiderLinks(unconfigured.revisionId)).map((result) => result.outcome),
    ["kept"],
  );
  assert.equal((await shareState(unconfigured.shareId)).moderation, "held");
});

test("a clean answer never opens a link held for another reason, or a disabled owner's link", async () => {
  config.SHARE_MODERATION = "auto";
  config.NEW_ACCOUNT_MAX_LINKS = 0;
  const model = gatedModel("none");
  setContentModels({ primary: model.client, fallback: null });
  const young = await signedUp(0);
  const others = [
    ["held", "suspicious"],
    ["held", "content:drugs"],
    ["held", "spam:duplicate"],
    ["held", "review-all"],
    ["held", "model-unavailable"],
    ["paused", "reports"],
  ] as const;
  const links = [];
  for (const [state, reason] of others) {
    const link = await imageLink(young);
    await db.query(
      "UPDATE shares SET moderation=$2,moderation_reason=$3 WHERE id=$1",
      [link.shareId, state, reason],
    );
    links.push({ link, state, reason });
  }
  const disabled = await signedUp(0);
  const theirs = await imageLink(disabled);
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [disabled.id]);
  model.open();
  await reviewsSettled();
  for (const { link, state, reason } of links) {
    assert.deepEqual(await shareState(link.shareId), { moderation: state, moderation_reason: reason });
    assert.equal((await eventsOf(link.shareId, "share.released")).length, 0);
  }
  assert.equal((await shareState(theirs.shareId)).moderation, "held");
});

test("links held as new-account under the old mode: released by the model only under auto", async () => {
  config.SHARE_MODERATION = "new-accounts";
  const model = gatedModel("none");
  setContentModels({ primary: model.client, fallback: null });
  const young = await signedUp(0);
  const link = await sharedLink(young, HONEST.replace("Отчёт", "Сводка новичка"));
  assert.equal(link.moderation, "held");
  assert.equal((await shareState(link.shareId)).moderation_reason, "new-account");
  model.open();
  await reviewsSettled();
  // Still new-accounts: the operator decides.
  assert.equal((await shareState(link.shareId)).moderation, "held");
  config.SHARE_MODERATION = "auto";
  const { reconsiderLinks } = await import("../apps/server/shares.ts");
  assert.deepEqual(
    (await reconsiderLinks(link.revisionId)).map((result) => result.outcome),
    ["released"],
  );
  assert.deepEqual(await shareState(link.shareId), { moderation: "none", moderation_reason: null });
  assert.deepEqual(await eventsOf(link.shareId, "share.released"), [
    { actor: "filter", reason: "new-account" },
  ]);
});

test("recheck: a dry run changes nothing; the real run decides checked revisions now and sends the rest to the model", async () => {
  const { recheckHeldShares, formatRecheck } = await import("../apps/server/shares.ts");
  config.SHARE_MODERATION = "auto";
  setContentModels(null);
  const young = await signedUp(0);
  // Saved while no model was configured: the image waits.
  const image = await imageLink(young);
  // Held under the old mode, text only.
  const legacy = await sharedLink(young, HONEST.replace("Отчёт", "Старая сводка"));
  await db.query(
    "UPDATE shares SET moderation='held',moderation_reason='new-account' WHERE id=$1",
    [legacy.shareId],
  );
  const other = await imageLink(young);
  await db.query("UPDATE shares SET moderation_reason='suspicious' WHERE id=$1", [other.shareId]);

  type Report = Awaited<ReturnType<typeof recheckHeldShares>>;
  const outcome = (report: Report, shareId: string) =>
    report.results.find((result) => result.shareId === shareId)?.outcome;
  const dry = await recheckHeldShares(true, [young.tenant]);
  assert.equal(dry.results.length, 2);
  assert.equal(outcome(dry, image.shareId), "kept");
  assert.equal(outcome(dry, legacy.shareId), "released");
  assert.match(formatRecheck(dry), /Dry run: 2 links.*Nothing changed/);
  assert.equal((await shareState(legacy.shareId)).moderation, "held");
  assert.equal((await eventsOf(legacy.shareId, "share.released")).length, 0);

  // No model: the image keeps waiting, the old text-only hold opens.
  const real = await recheckHeldShares(false, [young.tenant]);
  assert.equal(outcome(real, image.shareId), "kept");
  assert.equal(outcome(real, legacy.shareId), "released");
  assert.equal((await shareState(legacy.shareId)).moderation, "none");
  assert.equal((await shareState(image.shareId)).moderation, "held");
  assert.equal((await shareState(other.shareId)).moderation_reason, "suspicious");

  // A model now: the unchecked image goes to it and opens on a clean answer.
  setContentModels({ primary: fakeModel("m", () => "none"), fallback: null });
  const asks = await recheckHeldShares(true, [young.tenant]);
  assert.equal(asks.reviewed, 1);
  assert.match(formatRecheck(asks), /would ask the model/);
  assert.equal((await shareState(image.shareId)).moderation, "held");
  const reviewed = await recheckHeldShares(false, [young.tenant]);
  assert.equal(outcome(reviewed, image.shareId), "released");
  assert.match(formatRecheck(reviewed), /Released 1;/);
  assert.equal((await shareState(image.shareId)).moderation, "none");
  assert.match(
    formatRecheck(await recheckHeldShares(false, [young.tenant])),
    /No links wait only for the model/,
  );
});
