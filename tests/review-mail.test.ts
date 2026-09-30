// Letters to the author about a link under review (docs/specs/LINK_REVIEW_LETTERS.md):
// told once that it waits (not at once, not for a spam hold), once that it was
// approved, again only for a new round, never without an address, and what the
// owner's screen says about it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { sendReviewLetters, setReviewMailTransport } from "../apps/server/review-mail.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

(config as { MAIL_MODE: string }).MAIL_MODE = "local";
const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";
const sent: Array<{ to: string; subject: string; text: string }> = [];

const call = (method: any, url: string, body?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie }, payload: body as any });

async function sharedWork(title: string) {
  const bytes = Buffer.from(`<!doctype html><title>${title}</title><p>${randomUUID()}</p>`);
  const begun = await call("POST", "/api/uploads", { key: randomUUID(), title, filename: "index.html", mime: "text/html", size: bytes.length, sha256: sha256(bytes) });
  const uploadId = begun.json().uploadId as string;
  await app.inject({ method: "PUT", url: `/api/uploads/${uploadId}/bytes`, headers: { origin, cookie, "content-type": "application/octet-stream" }, payload: bytes });
  const done = (await call("POST", `/api/uploads/${uploadId}/finalize`, {})).json();
  const shared = await call("POST", `/api/artifacts/${done.artifactId}/share`, { expectedRevisionId: done.revisionId, expiresInDays: 7 });
  assert.equal(shared.statusCode, 200, shared.body);
  return { artifactId: done.artifactId as string, shareId: shared.json().share.id as string };
}
const setState = (shareId: string, moderation: string, minutesAgo: number, reason: string | null = null) =>
  db.query(
    "UPDATE shares SET moderation=$2,moderation_reason=$3,moderated_at=now()-make_interval(mins=>$4) WHERE id=$1",
    [shareId, moderation, reason, minutesAgo],
  );

before(async () => {
  owner = await createAccount(`review-${randomBytes(5).toString("hex")}`, password);
  await db.query("UPDATE accounts SET email=$2 WHERE id=$1", [owner.id, `author-${randomBytes(4).toString("hex")}@example.test`]);
  const login = await app.inject({ method: "POST", url: "/api/login", headers: { origin }, payload: { name: owner.name, password } });
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  setReviewMailTransport(async (mail) => (sent.push(mail), true));
});
after(async () => {
  setReviewMailTransport(undefined);
  await app.close();
  await db.end();
  s3.destroy();
});

test("the author is told once that the link waits, and once that it was approved", async () => {
  const work = await sharedWork("Ссылка под проверкой");
  sent.length = 0;
  // Just held: a link the model releases by itself is not written about.
  await setState(work.shareId, "held", 1, "new-account");
  assert.equal(await sendReviewLetters(), 0);
  await setState(work.shareId, "held", 10, "new-account");
  assert.equal(await sendReviewLetters(), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.subject, /на проверке/);
  assert.match(sent[0]!.subject, /Ссылка под проверкой/);
  assert.match(sent[0]!.text, /откроется по той же ссылке/);
  assert.ok(sent[0]!.text.includes(`/works/${work.artifactId}`));
  // Nothing of why: no signal, no finding, no setting name.
  assert.doesNotMatch(sent[0]!.text, /new-account|SHARE_MODERATION|фишинг:|признак/i);
  // Once.
  assert.equal(await sendReviewLetters(), 0);
  // The owner's screen says since when.
  const share = (await call("GET", `/api/artifacts/${work.artifactId}`)).json().share;
  assert.equal(share.moderation, "held");
  assert.ok(Date.now() - new Date(share.reviewSince).getTime() > 9 * 60_000);
  // Approved: one more letter, and only one.
  await setState(work.shareId, "none", 0);
  assert.equal(await sendReviewLetters(), 1);
  assert.match(sent[1]!.subject, /одобрена/);
  assert.equal(await sendReviewLetters(), 0);
  assert.equal((await call("GET", `/api/artifacts/${work.artifactId}`)).json().share.reviewSince, undefined);
  // A new round after a complete one is told about again.
  await setState(work.shareId, "paused", 10, "reports");
  assert.equal(await sendReviewLetters(), 1);
  assert.equal(sent.length, 3);
});

test("a spam hold, a blocked link, a released-at-once link and an author without an address get no letter", async () => {
  sent.length = 0;
  const spam = await sharedWork("Спам");
  await setState(spam.shareId, "held", 30, "spam:duplicate");
  const blocked = await sharedWork("Заблокирована");
  await setState(blocked.shareId, "blocked", 30, "content:drugs");
  const released = await sharedWork("Сама открылась");
  await setState(released.shareId, "held", 1, "image-unchecked");
  await setState(released.shareId, "none", 0, null);
  assert.equal(await sendReviewLetters(), 0);
  await db.query("UPDATE accounts SET email=NULL WHERE id=$1", [owner.id]);
  const held = await sharedWork("Без почты");
  await setState(held.shareId, "held", 30, "new-account");
  assert.equal(await sendReviewLetters(), 0);
  assert.equal(sent.length, 0);
  // With mail disabled nothing is attempted.
  (config as { MAIL_MODE: string }).MAIL_MODE = "disabled";
  try {
    assert.equal(await sendReviewLetters(), 0);
  } finally {
    (config as { MAIL_MODE: string }).MAIL_MODE = "local";
  }
});
