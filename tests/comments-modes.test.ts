// COMMENTS_MODE (docs/specs/SIGN_IN_PROVIDERS.md § 4): owner-notes lets only
// the work's owner and their agent write, recipients read, reactions and
// letters are off and recipients' earlier comments are hidden but kept; off
// removes discussions altogether.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createApp } from "../apps/server/app.ts";
import { createOwnerNoteInTransaction } from "../apps/server/comments.ts";
import { config } from "../apps/server/config.ts";
import { db, transaction } from "../apps/server/db.ts";
import { LOCAL_COMMENT_MAIL_DIRECTORY } from "../apps/server/mailer.ts";
import { reviewLoopGuide } from "../apps/server/mcp-server.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const savedMode = config.COMMENTS_MODE;
after(async () => {
  config.COMMENTS_MODE = savedMode;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await app.close();
  await db.end();
  s3.destroy();
});

const address = () =>
  `2001:db8:c1::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

type Person = { id: string; tenant: string; cookie: string; email: string };

async function person(label: string): Promise<Person> {
  const id = randomUUID(),
    tenant = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
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
  return { id, tenant, cookie: `polka_session=${token}`, email };
}

function call(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  cookie = "",
) {
  return app.inject({
    method,
    url,
    remoteAddress: address(),
    headers: { origin, ...(cookie ? { cookie } : {}) },
    payload: body as any,
  });
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>План</title></head><body><h1>План</h1><p>Первый шаг. Второй шаг.</p></body></html>`;

async function link(owner: Person) {
  const bytes = Buffer.from(PAGE);
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
  const receipt = done.json();
  const shared = await call(
    "POST",
    `/api/artifacts/${receipt.artifactId}/share`,
    { expectedRevisionId: receipt.revisionId, expiresInDays: 7 },
    owner.cookie,
  );
  assert.equal(shared.statusCode, 200, shared.body);
  const share = shared.json().share;
  return {
    artifactId: receipt.artifactId as string,
    shareId: share.id as string,
    token: new URL(share.url).hash.slice(1),
  };
}

const anchor = { exact: "Второй шаг.", prefix: "Первый шаг. ", suffix: "" };
const letters = async () => {
  try {
    return (await readdir(LOCAL_COMMENT_MAIL_DIRECTORY)).length;
  } catch {
    return 0;
  }
};

test("owner-notes: recipients read the owner's notes and cannot write or react", async () => {
  config.COMMENTS_MODE = "on";
  const owner = await person("owner");
  const reader = await person("reader");
  const work = await link(owner);
  // Written while comments were on.
  const earlier = await call(
    "POST",
    "/api/shared/comments/create",
    { token: work.token, body: "Старый комментарий получателя" },
    reader.cookie,
  );
  assert.equal(earlier.statusCode, 200, earlier.body);
  const reacted = await call(
    "POST",
    "/api/shared/comments/react",
    { token: work.token, emoji: "👍" },
    reader.cookie,
  );
  assert.equal(reacted.statusCode, 200, reacted.body);

  config.COMMENTS_MODE = "owner-notes";
  const lettersBefore = await letters();
  const note = await call(
    "POST",
    `/api/artifacts/${work.artifactId}/comments`,
    { shareId: work.shareId, body: "Заметка автора: проверить цифры", anchor },
    owner.cookie,
  );
  assert.equal(note.statusCode, 200, note.body);
  // The owner may also write through the link itself.
  const viaLink = await call(
    "POST",
    "/api/shared/comments/create",
    { token: work.token, body: "Ещё заметка" },
    owner.cookie,
  );
  assert.equal(viaLink.statusCode, 200, viaLink.body);

  const seen = await call(
    "POST",
    "/api/shared/comments",
    { token: work.token },
    reader.cookie,
  );
  assert.equal(seen.statusCode, 200, seen.body);
  assert.equal(seen.json().mode, "owner-notes");
  assert.deepEqual(
    seen.json().threads.map((thread: any) => thread.body),
    ["Заметка автора: проверить цифры", "Ещё заметка"],
  );
  assert.deepEqual(seen.json().reactions, []);
  assert.ok(
    seen
      .json()
      .threads.every((thread: any) => !thread.canDelete && !thread.canResolve),
  );
  // A guest reads them too.
  assert.equal(
    (await call("POST", "/api/shared/comments", { token: work.token })).json()
      .threads.length,
    2,
  );

  for (const [url, body] of [
    [
      "/api/shared/comments/create",
      { token: work.token, body: "Можно ответить?" },
    ],
    [
      "/api/shared/comments/create",
      { token: work.token, body: "Ответ", parentId: note.json().id },
    ],
    ["/api/shared/comments/react", { token: work.token, emoji: "👍" }],
    [
      "/api/shared/comments/delete",
      { token: work.token, commentId: earlier.json().id },
    ],
    [
      "/api/shared/comments/resolve",
      { token: work.token, commentId: earlier.json().id, resolved: true },
    ],
  ] as const) {
    const refused = await call("POST", url, body, reader.cookie);
    assert.equal(refused.statusCode, 403, `${url}: ${refused.body}`);
  }
  const guest = await call("POST", "/api/shared/comments/create", {
    token: work.token,
    body: "Гость",
  });
  assert.equal(guest.statusCode, 403);
  assert.match(guest.json().message, /получатели не оставляют комментарии/);
  // Nor does the owner react.
  const ownerReact = await call(
    "POST",
    `/api/artifacts/${work.artifactId}/reactions`,
    { shareId: work.shareId, emoji: "👍" },
    owner.cookie,
  );
  assert.equal(ownerReact.statusCode, 403);

  // The owner's page shows notes only, with nothing unread.
  const page = await call(
    "GET",
    `/api/artifacts/${work.artifactId}/comments`,
    undefined,
    owner.cookie,
  );
  assert.equal(page.json().mode, "owner-notes");
  assert.equal(page.json().unread, 0);
  assert.equal(page.json().shares[0].threads.length, 2);
  // No letters about notes.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await letters(), lettersBefore);

  // The recipient's comment and reaction are hidden, not deleted.
  const kept = await db.query("SELECT body FROM comments WHERE id=$1", [
    earlier.json().id,
  ]);
  assert.equal(kept.rows[0].body, "Старый комментарий получателя");
  config.COMMENTS_MODE = "on";
  const back = await call(
    "POST",
    "/api/shared/comments",
    { token: work.token },
    reader.cookie,
  );
  assert.equal(back.json().threads.length, 3);
  assert.equal(back.json().reactions.length, 1);
});

test("owner-notes: the owner's agent notes the newest open link", async () => {
  config.COMMENTS_MODE = "owner-notes";
  const owner = await person("agent-owner");
  const work = await link(owner);
  const created = await transaction((c) =>
    createOwnerNoteInTransaction(
      c,
      { id: owner.id, tenant: owner.tenant },
      work.artifactId,
      undefined,
      {
        body: "Агент: поправить второй шаг",
        anchor,
      },
    ),
  );
  assert.equal(created.shareId, work.shareId);
  const seen = await call("POST", "/api/shared/comments", {
    token: work.token,
  });
  assert.deepEqual(
    seen.json().threads.map((thread: any) => thread.body),
    ["Агент: поправить второй шаг"],
  );
  assert.match(reviewLoopGuide("owner-notes"), /only the owner writes/);
  assert.match(reviewLoopGuide("off"), /turned off/);
  config.COMMENTS_MODE = "on";
});

test("off: no discussion for recipients, an empty one for the owner, no writing", async () => {
  config.COMMENTS_MODE = "on";
  const owner = await person("off-owner");
  const work = await link(owner);
  config.COMMENTS_MODE = "off";
  try {
    assert.equal(
      (await call("POST", "/api/shared/comments", { token: work.token }))
        .statusCode,
      404,
    );
    const page = await call(
      "GET",
      `/api/artifacts/${work.artifactId}/comments`,
      undefined,
      owner.cookie,
    );
    assert.equal(page.statusCode, 200);
    assert.deepEqual(page.json().shares, []);
    assert.equal(page.json().mode, "off");
    const write = await call(
      "POST",
      `/api/artifacts/${work.artifactId}/comments`,
      { shareId: work.shareId, body: "Нельзя" },
      owner.cookie,
    );
    assert.equal(write.statusCode, 404);
    const capabilities = (await call("GET", "/api/capabilities")).json();
    assert.equal(capabilities.commentsMode, "off");
  } finally {
    config.COMMENTS_MODE = "on";
  }
});
