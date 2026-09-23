// Comments and reactions on the text of a shared work (docs/specs/COMMENTS.md):
// threads belong to a link, writing needs an account, the owner sees every
// link's threads, deletion and resolve rules, reactions toggle, limits,
// letters (MAIL_MODE=local), moderation hooks and reports on comments.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  COMMENT_ACTIONS_PER_AUTHOR_PER_HOUR,
  COMMENT_MAIL_PER_ADDRESS_PER_DAY,
  COMMENTS_PER_SHARE_PER_DAY,
} from "../packages/contracts/comments.ts";
import { createApp } from "../apps/server/app.ts";
import { commentSignals } from "../apps/server/comments.ts";
import { defang, excerpt } from "../apps/server/comment-mail.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  LOCAL_COMMENT_MAIL_DIRECTORY,
  LOCAL_OPERATOR_MAIL_DIRECTORY,
} from "../apps/server/mailer.ts";
import {
  deleteCommentAsOperator,
  disableAccount,
  enableAccount,
  listShareComments,
  releaseCommentAsOperator,
} from "../apps/server/moderation.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
if (config.MAIL_MODE !== "local")
  throw new Error("Comment tests read letters from local mail");
const operatorEmail = config.OPERATOR_EMAIL;
config.OPERATOR_EMAIL = "operator-comments@example.test";

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  config.OPERATOR_EMAIL = operatorEmail;
  await app.close();
  await db.end();
  s3.destroy();
});

const address = () =>
  `2001:db8:c0::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

type Person = {
  id: string;
  tenant: string;
  cookie: string;
  email: string;
  name: string;
};

async function session(accountId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [sha256(token), accountId],
  );
  return `polka_session=${token}`;
}

/** An email account; `trusted` as if the operator approved it. */
async function person(
  label: string,
  trusted = true,
  named = true,
): Promise<Person> {
  const id = randomUUID(),
    tenant = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await db.query(
    `INSERT INTO accounts(id,name,password_hash,email,display_name,created_at,trusted_at,comment_name_chosen_at)
     VALUES($1,$2,'unused',$3,$4,now(),CASE WHEN $5::boolean THEN now() END,
       CASE WHEN $6::boolean THEN now() END)`,
    [id, `email-${id}`, email, label, trusted, named],
  );
  await db.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
    tenant,
    id,
  ]);
  return { id, tenant, cookie: await session(id), email, name: label };
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Отчёт</title></head><body><h1>Квартальный отчёт</h1><p>Выручка выросла на 12%. Расходы стабильны. Выручка выросла на 12%.</p></body></html>`;

async function save(owner: Person, html = PAGE) {
  const bytes = Buffer.from(html);
  const begin = await call(
    "POST",
    "/api/uploads",
    {
      key: randomUUID(),
      title: "Отчёт",
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

async function link(owner: Person, html = PAGE) {
  const receipt = await save(owner, html);
  const response = await call(
    "POST",
    `/api/artifacts/${receipt.artifactId}/share`,
    { expectedRevisionId: receipt.revisionId, expiresInDays: 7 },
    owner.cookie,
  );
  assert.equal(response.statusCode, 200, response.body);
  const share = response.json().share;
  return {
    ...receipt,
    shareId: share.id as string,
    token: new URL(share.url).hash.slice(1),
  };
}

const list = (token: string, cookie = "") =>
  call("POST", "/api/shared/comments", { token }, cookie);
const write = (token: string, cookie: string, body: Record<string, unknown>) =>
  call("POST", "/api/shared/comments/create", { token, ...body }, cookie);
const react = (token: string, cookie: string, body: Record<string, unknown>) =>
  call("POST", "/api/shared/comments/react", { token, ...body }, cookie);
const anchor = { exact: "Расходы стабильны.", prefix: "на 12%. ", suffix: " Выручка" };

type Letter = { to: string; subject: string; text: string };
async function lettersIn(directory: string, match: (letter: Letter) => boolean, count = 1) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found: Letter[] = [];
    try {
      for (const name of (await readdir(directory)).sort()) {
        const letter = JSON.parse(
          await readFile(join(directory, name), "utf8"),
        ) as Letter;
        if (match(letter)) found.push(letter);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (found.length >= count || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a guest reads a link's threads; writing needs an account", async () => {
  const owner = await person("owner");
  const work = await link(owner);
  const guest = await list(work.token);
  assert.equal(guest.statusCode, 200, guest.body);
  assert.deepEqual(guest.json().threads, []);
  assert.deepEqual(guest.json().viewer, {
    signedIn: false,
    name: null,
    owner: false,
    nameChosen: false,
    commentMail: true,
  });
  const refused = await write(work.token, "", { body: "Привет" });
  assert.equal(refused.statusCode, 401);
  assert.match(refused.json().message, /Войдите по почте/);
  assert.equal((await react(work.token, "", { emoji: "👍" })).statusCode, 401);
  // A forged or other link's token opens nothing.
  assert.equal(
    (await list(randomBytes(32).toString("base64url"))).statusCode,
    404,
  );
  // Browser routes keep the Origin rule.
  const foreign = await app.inject({
    method: "POST",
    url: "/api/shared/comments",
    headers: { origin: "https://evil.example" },
    payload: { token: work.token },
  });
  assert.equal(foreign.statusCode, 403);
});

test("threads belong to a link: recipients of one never see another's", async () => {
  const owner = await person("owner");
  const reader = await person("reader");
  const other = await person("other");
  const first = await link(owner);
  const a = await write(first.token, reader.cookie, {
    body: "Замечание к первой ссылке",
    anchor,
  });
  assert.equal(a.statusCode, 200, a.body);
  // A link of another work of the same owner: its own thread set.
  const elsewhere = await link(owner);
  const c = await write(elsewhere.token, other.cookie, {
    body: "Замечание к другой работе",
  });
  assert.equal(c.statusCode, 200, c.body);
  assert.deepEqual(
    (await list(elsewhere.token, reader.cookie))
      .json()
      .threads.map((thread: any) => thread.body),
    ["Замечание к другой работе"],
  );
  assert.deepEqual(
    (await list(first.token, other.cookie))
      .json()
      .threads.map((thread: any) => thread.body),
    ["Замечание к первой ссылке"],
  );
  // A second link of the same work (one link is open at a time: the first
  // closes). Its recipients start with an empty discussion.
  const again = await call(
    "POST",
    `/api/shares/${first.shareId}/revoke`,
    {},
    owner.cookie,
  );
  assert.equal(again.statusCode, 200);
  const second = await call(
    "POST",
    `/api/artifacts/${first.artifactId}/share`,
    { expectedRevisionId: first.revisionId, expiresInDays: 7 },
    owner.cookie,
  );
  assert.equal(second.statusCode, 200, second.body);
  const secondToken = new URL(second.json().share.url).hash.slice(1);
  const secondShareId = second.json().share.id as string;
  assert.deepEqual((await list(secondToken, other.cookie)).json().threads, []);
  const b = await write(secondToken, other.cookie, {
    body: "Замечание ко второй ссылке",
  });
  assert.equal(b.statusCode, 200, b.body);
  // The first link is closed: its recipients reach nothing now.
  assert.equal((await list(first.token, reader.cookie)).statusCode, 404);
  const seenBySecond = (await list(secondToken, other.cookie)).json();
  assert.deepEqual(
    seenBySecond.threads.map((thread: any) => thread.body),
    ["Замечание ко второй ссылке"],
  );
  // No crossing by ids either: reply, delete and resolve through the other
  // link's token find nothing.
  assert.equal(
    (
      await write(elsewhere.token, other.cookie, {
        body: "ответ",
        parentId: b.json().id,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/shared/comments/delete",
        { token: elsewhere.token, commentId: b.json().id },
        owner.cookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/api/shared/comments/resolve",
        { token: elsewhere.token, commentId: b.json().id },
        owner.cookie,
      )
    ).statusCode,
    404,
  );
  // The owner sees both links' threads, grouped.
  const work = await call(
    "GET",
    `/api/artifacts/${first.artifactId}/comments`,
    undefined,
    owner.cookie,
  );
  assert.equal(work.statusCode, 200, work.body);
  const byShare = Object.fromEntries(
    work
      .json()
      .shares.map((share: any) => [
        share.shareId,
        share.threads.map((thread: any) => thread.body),
      ]),
  );
  assert.deepEqual(byShare[first.shareId], ["Замечание к первой ссылке"]);
  assert.deepEqual(byShare[secondShareId], ["Замечание ко второй ссылке"]);
  assert.equal(work.json().unread, 2);
  assert.equal(
    (
      await call(
        "POST",
        `/api/artifacts/${first.artifactId}/comments/seen`,
        {},
        owner.cookie,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/api/artifacts/${first.artifactId}/comments`,
        undefined,
        owner.cookie,
      )
    ).json().unread,
    0,
  );
  // Another shelf's owner gets nothing.
  assert.equal(
    (
      await call(
        "GET",
        `/api/artifacts/${first.artifactId}/comments`,
        undefined,
        reader.cookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/api/comments/${a.json().id}/delete`,
        {},
        reader.cookie,
      )
    ).statusCode,
    404,
  );
  // Author shown by display name, never by address.
  const payload = JSON.stringify(seenBySecond);
  assert.ok(!payload.includes(other.email));
  assert.ok(!payload.includes(owner.email));
  assert.equal(seenBySecond.threads[0].author.name, "other");
});

test("replies are one level; resolve and delete follow owner and author", async () => {
  const owner = await person("owner");
  const alice = await person("alice");
  const bob = await person("bob");
  const work = await link(owner);
  const root = (
    await write(work.token, alice.cookie, { body: "Корень", anchor })
  ).json().id;
  const reply = await write(work.token, bob.cookie, {
    body: "Ответ",
    parentId: root,
  });
  assert.equal(reply.statusCode, 200, reply.body);
  // No reply to a reply; a reply has no quote of its own.
  assert.equal(
    (
      await write(work.token, alice.cookie, {
        body: "Ответ на ответ",
        parentId: reply.json().id,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await write(work.token, alice.cookie, {
        body: "x",
        parentId: root,
        anchor,
      })
    ).statusCode,
    400,
  );
  const act = (path: string, cookie: string, body: Record<string, unknown>) =>
    call("POST", `/api/shared/comments/${path}`, { token: work.token, ...body }, cookie);
  // Bob may neither resolve Alice's thread nor delete her comment.
  assert.equal(
    (await act("resolve", bob.cookie, { commentId: root })).statusCode,
    404,
  );
  assert.equal(
    (await act("delete", bob.cookie, { commentId: root })).statusCode,
    404,
  );
  // A reply is not a thread.
  assert.equal(
    (await act("resolve", bob.cookie, { commentId: reply.json().id }))
      .statusCode,
    409,
  );
  assert.equal(
    (await act("resolve", alice.cookie, { commentId: root })).statusCode,
    200,
  );
  let threads = (await list(work.token, alice.cookie)).json().threads;
  assert.ok(threads[0].resolvedAt);
  assert.equal(threads[0].canResolve, true);
  assert.equal(threads[0].replies[0].canDelete, false);
  // The owner reopens it and deletes Alice's root; the reply keeps the
  // thread, which stays as an empty placeholder.
  assert.equal(
    (
      await call(
        "POST",
        `/api/comments/${root}/resolve`,
        { resolved: false },
        owner.cookie,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await call("POST", `/api/comments/${root}/delete`, {}, owner.cookie))
      .statusCode,
    200,
  );
  threads = (await list(work.token, bob.cookie)).json().threads;
  assert.equal(threads.length, 1);
  assert.equal(threads[0].deleted, true);
  assert.equal(threads[0].body, "");
  assert.equal(threads[0].author, null);
  assert.equal(threads[0].resolvedAt, null);
  assert.equal(threads[0].replies[0].body, "Ответ");
  // Bob deletes his own reply: the placeholder goes too.
  assert.equal(
    (await act("delete", bob.cookie, { commentId: reply.json().id }))
      .statusCode,
    200,
  );
  assert.deepEqual((await list(work.token)).json().threads, []);
  const {
    rows: [stored],
  } = await db.query("SELECT body,deleted_at FROM comments WHERE id=$1", [root]);
  assert.equal(stored.body, "");
  assert.ok(stored.deleted_at);
});

test("reactions toggle per author, fragment and emoji", async () => {
  const owner = await person("owner");
  const alice = await person("alice");
  const bob = await person("bob");
  const work = await link(owner);
  const on = await react(work.token, alice.cookie, { emoji: "👍", anchor });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(on.json().active, true);
  assert.equal(
    (await react(work.token, bob.cookie, { emoji: "👍", anchor })).json().active,
    true,
  );
  assert.equal(
    (await react(work.token, alice.cookie, { emoji: "🎉" })).json().active,
    true,
  );
  let groups = (await list(work.token, alice.cookie)).json().reactions;
  const thumbs = groups.find((group: any) => group.emoji === "👍");
  assert.equal(thumbs.count, 2);
  assert.equal(thumbs.mine, true);
  assert.match(thumbs.sig, /^[a-f0-9]{64}$/);
  assert.equal(thumbs.anchor.exact, anchor.exact);
  const whole = groups.find((group: any) => group.emoji === "🎉");
  assert.equal(whole.sig, "");
  assert.equal(whole.anchor, null);
  // Pressing it again takes it back.
  assert.equal(
    (await react(work.token, alice.cookie, { emoji: "👍", anchor })).json()
      .active,
    false,
  );
  groups = (await list(work.token, alice.cookie)).json().reactions;
  assert.equal(groups.find((group: any) => group.emoji === "👍").count, 1);
  assert.equal(groups.find((group: any) => group.emoji === "👍").mine, false);
  // Only the fixed set.
  assert.equal(
    (await react(work.token, alice.cookie, { emoji: "💩" })).statusCode,
    400,
  );
  // Reactions write no letters.
  const letters = await lettersIn(
    LOCAL_COMMENT_MAIL_DIRECTORY,
    (letter) => letter.to === owner.email,
    1,
  );
  assert.equal(letters.length, 0);
});

test("revoke, expiry and review close a link's discussion for recipients only", async () => {
  const owner = await person("owner");
  const reader = await person("reader");
  const work = await link(owner);
  const id = (await write(work.token, reader.cookie, { body: "До отзыва" })).json()
    .id;
  await db.query(
    "UPDATE shares SET moderation='paused',moderation_reason='reports' WHERE id=$1",
    [work.shareId],
  );
  assert.equal((await list(work.token, reader.cookie)).statusCode, 404);
  await db.query("UPDATE shares SET moderation='none' WHERE id=$1", [
    work.shareId,
  ]);
  assert.equal((await list(work.token, reader.cookie)).statusCode, 200);
  assert.equal(
    (await call("POST", `/api/shares/${work.shareId}/revoke`, {}, owner.cookie))
      .statusCode,
    200,
  );
  assert.equal((await list(work.token, reader.cookie)).statusCode, 404);
  assert.equal(
    (await write(work.token, reader.cookie, { body: "После" })).statusCode,
    404,
  );
  const owned = await call(
    "GET",
    `/api/artifacts/${work.artifactId}/comments`,
    undefined,
    owner.cookie,
  );
  const closed = owned.json().shares.find((s: any) => s.shareId === work.shareId);
  assert.equal(closed.state, "revoked");
  assert.equal(closed.threads[0].id, id);
  // The owner reads and moderates a closed link, but writes into it no more.
  const refused = await call(
    "POST",
    `/api/artifacts/${work.artifactId}/comments`,
    { shareId: work.shareId, body: "Ответ", parentId: id },
    owner.cookie,
  );
  assert.equal(refused.statusCode, 410);
  assert.equal(
    (await call("POST", `/api/comments/${id}/resolve`, {}, owner.cookie))
      .statusCode,
    200,
  );
  // Expiry acts like revoke.
  const later = await link(owner);
  await db.query(
    "UPDATE shares SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE id=$1",
    [later.shareId],
  );
  assert.equal((await list(later.token, reader.cookie)).statusCode, 404);
});

test("limits: 2000 characters, 60 actions an hour, 200 comments a day on a link", async () => {
  const owner = await person("owner");
  const reader = await person("reader");
  const work = await link(owner);
  assert.equal(
    (await write(work.token, reader.cookie, { body: "я".repeat(2001) }))
      .statusCode,
    400,
  );
  assert.equal(
    (await write(work.token, reader.cookie, { body: "я".repeat(2000) }))
      .statusCode,
    200,
  );
  assert.equal(
    (await write(work.token, reader.cookie, { body: "   " })).statusCode,
    400,
  );
  assert.equal(
    (await write(work.token, reader.cookie, { body: "a‮b" })).statusCode,
    400,
  );
  // One action is spent; the rest of the hour's allowance, then a refusal.
  for (let i = 1; i < COMMENT_ACTIONS_PER_AUTHOR_PER_HOUR; i++) {
    const response = await react(work.token, reader.cookie, {
      emoji: i % 2 ? "👍" : "👀",
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const over = await react(work.token, reader.cookie, { emoji: "✅" });
  assert.equal(over.statusCode, 429);
  // The link's daily limit counts every author.
  const busy = await link(owner);
  const other = await person("other");
  await db.query(
    `INSERT INTO comments(id,tenant_id,artifact_id,share_id,revision_id,author_account_id,body)
     SELECT gen_random_uuid(),$1,$2,$3,$4,$5,'заполнитель' FROM generate_series(1,$6)`,
    [
      owner.tenant,
      busy.artifactId,
      busy.shareId,
      busy.revisionId,
      reader.id,
      COMMENTS_PER_SHARE_PER_DAY,
    ],
  );
  const full = await write(busy.token, other.cookie, { body: "Ещё один" });
  assert.equal(full.statusCode, 429);
  assert.match(full.json().message, /за сутки/);
});

test("letters: the owner about each comment, the thread about replies, 30 a day", async () => {
  const owner = await person("owner");
  const alice = await person("alice");
  const bob = await person("bob");
  const work = await link(owner);
  const marker = randomBytes(6).toString("hex");
  const root = await write(work.token, alice.cookie, {
    body: `Первое ${marker}: см. https://evil.example/login`,
    anchor,
  });
  assert.equal(root.statusCode, 200, root.body);
  const toOwner = await lettersIn(
    LOCAL_COMMENT_MAIL_DIRECTORY,
    (letter) => letter.to === owner.email && letter.text.includes(marker),
  );
  assert.equal(toOwner.length, 1);
  assert.match(toOwner[0]!.text, /alice оставил\(а\) комментарий/);
  assert.match(toOwner[0]!.text, new RegExp(`${origin}/works/${work.artifactId}`));
  assert.match(toOwner[0]!.text, /evil\[\.\]example/);
  assert.ok(!toOwner[0]!.text.includes("https://evil.example"));
  assert.ok(!toOwner[0]!.text.includes(alice.email));
  assert.ok(!toOwner[0]!.text.includes(work.token));
  // A reply: Alice (in the thread) and the owner hear about it, Bob does not
  // write to himself.
  const replyMarker = randomBytes(6).toString("hex");
  assert.equal(
    (
      await write(work.token, bob.cookie, {
        body: `Ответ ${replyMarker}`,
        parentId: root.json().id,
      })
    ).statusCode,
    200,
  );
  const toAlice = await lettersIn(
    LOCAL_COMMENT_MAIL_DIRECTORY,
    (letter) => letter.to === alice.email && letter.text.includes(replyMarker),
  );
  assert.equal(toAlice.length, 1);
  assert.ok(!toAlice[0]!.text.includes(bob.email));
  assert.ok(!toAlice[0]!.text.includes(owner.email));
  assert.equal(
    (
      await lettersIn(
        LOCAL_COMMENT_MAIL_DIRECTORY,
        (letter) => letter.to === owner.email && letter.text.includes(replyMarker),
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await lettersIn(
        LOCAL_COMMENT_MAIL_DIRECTORY,
        (letter) => letter.to === bob.email,
        1,
      )
    ).length,
    0,
  );
  // A full day for this address: no more letters, the comment still saves.
  await db.query(
    "INSERT INTO login_limits VALUES($1,$2,now()+interval '1 day') ON CONFLICT(key) DO UPDATE SET attempts=$2",
    [sha256(`comment-mail:${owner.email}`), COMMENT_MAIL_PER_ADDRESS_PER_DAY],
  );
  const quiet = randomBytes(6).toString("hex");
  assert.equal(
    (await write(work.token, alice.cookie, { body: `Тихо ${quiet}` }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await lettersIn(
        LOCAL_COMMENT_MAIL_DIRECTORY,
        (letter) => letter.text.includes(quiet),
        1,
      )
    ).length,
    0,
  );
});

test("phishing signals hold a new author's comment; operator scripts decide", async () => {
  const owner = await person("owner");
  const newcomer = await person("newcomer", false);
  const reader = await person("reader");
  const work = await link(owner);
  const bait = "Срочно введите пароль от Сбербанка на sber-login.ru";
  assert.equal(commentSignals(bait).suspicious, true);
  assert.equal(commentSignals("Отличный отчёт, спасибо").suspicious, false);
  const held = await write(work.token, newcomer.cookie, { body: bait });
  assert.equal(held.statusCode, 200, held.body);
  const id = held.json().id as string;
  // Its author and the owner see it; nobody else does.
  assert.equal(
    (await list(work.token, newcomer.cookie)).json().threads[0].held,
    true,
  );
  assert.deepEqual((await list(work.token, reader.cookie)).json().threads, []);
  const owned = await call(
    "GET",
    `/api/artifacts/${work.artifactId}/comments`,
    undefined,
    owner.cookie,
  );
  assert.equal(owned.json().shares[0].threads[0].held, true);
  const toOperator = await lettersIn(
    LOCAL_OPERATOR_MAIL_DIRECTORY,
    (letter) => letter.text.includes(id),
  );
  assert.equal(toOperator.length, 1);
  assert.match(toOperator[0]!.subject, /подозрительный комментарий/);
  assert.match(toOperator[0]!.text, /sber-login\[\.\]ru/);
  // The script lists the link's comments, hidden ones included.
  const listed = await listShareComments(work.shareId);
  assert.equal(listed[0]!.state, "held");
  assert.equal((await releaseCommentAsOperator(id)).changed, true);
  assert.equal((await releaseCommentAsOperator(id)).changed, false);
  assert.equal((await list(work.token, reader.cookie)).json().threads.length, 1);
  assert.equal((await deleteCommentAsOperator(id)).changed, true);
  assert.deepEqual((await list(work.token, reader.cookie)).json().threads, []);
  // Disabling an author hides every comment and reaction of theirs; enabling
  // brings them back.
  const text = await write(work.token, newcomer.cookie, { body: "Обычный" });
  assert.equal(text.statusCode, 200, text.body);
  await react(work.token, newcomer.cookie, { emoji: "👀" });
  await db.query(
    "SELECT name FROM accounts WHERE id=$1",
    [newcomer.id],
  );
  const login = (
    await db.query("SELECT name FROM accounts WHERE id=$1", [newcomer.id])
  ).rows[0].name;
  await disableAccount(login, "comment spam");
  const hidden = (await list(work.token, reader.cookie)).json();
  assert.deepEqual(hidden.threads, []);
  assert.deepEqual(hidden.reactions, []);
  await enableAccount(login);
  assert.equal((await list(work.token, reader.cookie)).json().threads.length, 1);
});

test("a report on a comment reaches the operator and never pauses the link", async () => {
  const owner = await person("owner");
  const reader = await person("reader");
  const work = await link(owner);
  const id = (await write(work.token, reader.cookie, { body: "Грубость" })).json()
    .id;
  for (let i = 0; i < 4; i++) {
    const report = await call("POST", "/api/reports", {
      key: randomUUID(),
      token: work.token,
      reason: "other",
      commentId: id,
    });
    assert.equal(report.statusCode, 200, report.body);
  }
  const {
    rows: [state],
  } = await db.query("SELECT moderation FROM shares WHERE id=$1", [
    work.shareId,
  ]);
  assert.equal(state.moderation, "none");
  const {
    rows: [{ n }],
  } = await db.query(
    "SELECT count(*)::int AS n FROM share_reports WHERE comment_id=$1",
    [id],
  );
  assert.equal(n, 4);
  const letters = await lettersIn(
    LOCAL_OPERATOR_MAIL_DIRECTORY,
    (letter) => letter.text.includes(id) && /жалоба на комментарий/.test(letter.subject),
    4,
  );
  assert.equal(letters.length, 4);
  // A comment of another link, or a missing one, is refused.
  const elsewhere = await link(owner);
  assert.equal(
    (
      await call("POST", "/api/reports", {
        key: randomUUID(),
        token: elsewhere.token,
        reason: "other",
        commentId: id,
      })
    ).statusCode,
    404,
  );
});

test("an author deleting their account disappears from threads at once", async () => {
  const owner = await person("owner");
  const leaving = await person("leaving");
  const reader = await person("reader");
  const work = await link(owner);
  await write(work.token, leaving.cookie, { body: "Уйду" });
  await react(work.token, leaving.cookie, { emoji: "❤️" });
  await db.query(
    "UPDATE accounts SET disabled=true,deletion_requested_at=clock_timestamp() WHERE id=$1",
    [leaving.id],
  );
  const view = (await list(work.token, reader.cookie)).json();
  assert.deepEqual(view.threads, []);
  assert.deepEqual(view.reactions, []);
  // Nor can a session of theirs write.
  assert.equal(
    (await write(work.token, leaving.cookie, { body: "ещё" })).statusCode,
    401,
  );
});

test("the name under comments is chosen first, never an address", async () => {
  const owner = await person("owner");
  const fresh = await person("fresh-reader", true, false);
  const work = await link(owner);
  const before = (await list(work.token, fresh.cookie)).json().viewer;
  assert.equal(before.nameChosen, false);
  assert.equal(before.commentMail, true);
  // Without a name: refused, saying what is missing.
  const refused = await write(work.token, fresh.cookie, { body: "Первый" });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().nameRequired, true);
  // An address is not a name.
  assert.equal(
    (
      await write(work.token, fresh.cookie, {
        body: "Первый",
        displayName: "me@example.test",
      })
    ).statusCode,
    400,
  );
  const named = await write(work.token, fresh.cookie, {
    body: "Первый",
    displayName: "  Мария   К. ",
  });
  assert.equal(named.statusCode, 200, named.body);
  const after = (await list(work.token, fresh.cookie)).json();
  assert.equal(after.viewer.nameChosen, true);
  assert.equal(after.threads[0].author.name, "Мария К.");
  // Once chosen, a later name in a comment changes nothing.
  await write(work.token, fresh.cookie, { body: "Второй", displayName: "Другое" });
  assert.equal((await list(work.token, fresh.cookie)).json().viewer.name, "Мария К.");
  // The settings change it, and turn letters off and on.
  const settings = await call(
    "POST",
    "/api/account/comment-settings",
    { displayName: "Мария", commentMail: false },
    fresh.cookie,
  );
  assert.equal(settings.statusCode, 200, settings.body);
  assert.deepEqual(settings.json(), {
    name: "Мария",
    nameChosen: true,
    commentMail: false,
  });
  assert.equal(
    (await call("POST", "/api/account/comment-settings", {}, fresh.cookie))
      .statusCode,
    400,
  );
  assert.equal(
    (await call("POST", "/api/account/comment-settings", { commentMail: true }, ""))
      .statusCode,
    401,
  );
});

test("«Не присылать такие письма» turns the letters off with a signed link", async () => {
  const owner = await person("owner");
  const reader = await person("reader");
  const work = await link(owner);
  const first = randomBytes(6).toString("hex");
  await write(work.token, reader.cookie, { body: `Первое ${first}` });
  const [letter] = await lettersIn(
    LOCAL_COMMENT_MAIL_DIRECTORY,
    (item) => item.to === owner.email && item.text.includes(first),
  );
  assert.ok(letter);
  const off = /\/mail-off#(\S+)/.exec(letter.text)?.[1];
  assert.ok(off, letter.text);
  // A damaged token does nothing; the right one turns letters off, twice harmlessly.
  assert.equal(
    (await call("POST", "/api/comment-mail/off", { token: off.slice(0, -2) + "xx" })).statusCode,
    404,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await call("POST", "/api/comment-mail/off", { token: off })).statusCode,
      200,
    );
  const {
    rows: [account],
  } = await db.query("SELECT comment_mail FROM accounts WHERE id=$1", [owner.id]);
  assert.equal(account.comment_mail, false);
  const second = randomBytes(6).toString("hex");
  await write(work.token, reader.cookie, { body: `Второе ${second}` });
  assert.equal(
    (
      await lettersIn(
        LOCAL_COMMENT_MAIL_DIRECTORY,
        (item) => item.text.includes(second),
        1,
      )
    ).length,
    0,
  );
});

test("letters defang addresses and cut long text", () => {
  assert.equal(defang("см. https://a.example/x и www.b.ru"), "см. https[:]//a[.]example/x и www[.]b[.]ru");
  assert.equal(defang("3.14 — это число"), "3.14 — это число");
  assert.equal([...excerpt("я".repeat(400))].length, 300);
});
