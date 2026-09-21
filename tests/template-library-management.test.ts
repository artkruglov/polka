import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let curator: Awaited<ReturnType<typeof createAccount>>;
let outsider: Awaited<ReturnType<typeof createAccount>>;
let ownerCookie = "";
let curatorCookie = "";
let outsiderCookie = "";

async function call(
  method: any,
  url: string,
  body?: Record<string, unknown>,
  cookie = ownerCookie,
  origin = config.APP_ORIGIN,
) {
  return app.inject({
    method,
    url,
    headers: { origin, ...(cookie ? { cookie } : {}) },
    payload: body,
  });
}

async function login(name: string) {
  const response = await call("POST", "/api/login", { name, password }, "");
  assert.equal(response.statusCode, 200, response.body);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

async function release(cookie: string, title: string, plain = false) {
  const bytes = Buffer.from(
    plain
      ? title
      : `<!doctype html><html><body><h1>${title}</h1><p>Template source</p></body></html>`,
  );
  const begin = await call(
    "POST",
    "/api/uploads",
    {
      key: randomUUID(),
      title,
      filename: plain ? "source.txt" : "source.html",
      mime: plain ? "text/plain" : "text/html",
      size: bytes.length,
      sha256: sha256(bytes),
    },
    cookie,
  );
  assert.equal(begin.statusCode, 200, begin.body);
  const uploadId = begin.json().uploadId;
  const upload = await app.inject({
    method: "PUT",
    url: `/api/uploads/${uploadId}/bytes`,
    headers: {
      origin: config.APP_ORIGIN,
      cookie,
      "content-type": "application/octet-stream",
    },
    payload: bytes,
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const saved = await call(
    "POST",
    `/api/uploads/${uploadId}/finalize`,
    {},
    cookie,
  );
  assert.equal(saved.statusCode, 200, saved.body);
  const pinned = await call(
    "POST",
    `/api/artifacts/${saved.json().artifactId}/template-releases`,
    {
      revisionId: saved.json().revisionId,
      summary: `${title} summary`,
      rules: "Keep the layout",
      questions: "",
    },
    cookie,
  );
  assert.equal(pinned.statusCode, plain ? 422 : 200, pinned.body);
  if (plain) assert.equal(pinned.json().code, "unsupported");
  return { ...saved.json(), releaseId: pinned.json().releaseId };
}

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`library-owner-${suffix}`, password);
  curator = await createAccount(`library-curator-${suffix}`, password);
  outsider = await createAccount(`library-outsider-${suffix}`, password);
  ownerCookie = await login(owner.name);
  curatorCookie = await login(curator.name);
  outsiderCookie = await login(outsider.name);
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("HTTP library management preserves membership and owned-release boundaries", async () => {
  assert.equal(
    (
      await call(
        "POST",
        "/api/template-libraries",
        { name: "Wrong origin" },
        ownerCookie,
        "https://attacker.invalid",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await call("POST", "/api/template-libraries", { name: "Anonymous" }, ""))
      .statusCode,
    401,
  );

  const created = await call("POST", "/api/template-libraries", {
    name: "Brand team",
  });
  assert.equal(created.statusCode, 200, created.body);
  const libraryId = created.json().id as string;
  assert.equal(created.json().role, "admin");
  assert.equal(
    (await call("GET", "/api/template-libraries")).json().items[0].id,
    libraryId,
  );
  assert.equal(
    (
      await call("GET", "/api/template-libraries", undefined, outsiderCookie)
    ).json().items.length,
    0,
  );

  await db.query(
    "INSERT INTO template_library_members(library_id,account_id,role) VALUES($1,$2,'reader')",
    [libraryId, curator.id],
  );
  const members = await call(
    "GET",
    `/api/template-libraries/${libraryId}/members`,
    undefined,
    curatorCookie,
  );
  assert.equal(members.statusCode, 200, members.body);
  assert.equal(members.json().items.length, 2);
  assert.equal(JSON.stringify(members.json()).includes("email"), false);
  assert.equal(
    (
      await call(
        "GET",
        `/api/template-libraries/${libraryId}/members`,
        undefined,
        outsiderCookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/api/template-libraries/${libraryId}/events`,
        undefined,
        curatorCookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/api/template-libraries/${libraryId}/events`,
        undefined,
        outsiderCookie,
      )
    ).statusCode,
    404,
  );

  assert.equal(
    (
      await call(
        "PATCH",
        `/api/template-libraries/${libraryId}/members/${curator.id}`,
        { role: "curator" },
        curatorCookie,
      )
    ).statusCode,
    404,
  );
  const promoted = await call(
    "PATCH",
    `/api/template-libraries/${libraryId}/members/${curator.id}`,
    { role: "curator" },
  );
  assert.equal(promoted.statusCode, 200, promoted.body);
  assert.equal(promoted.json().role, "curator");
  assert.equal(
    (
      await call(
        "PATCH",
        `/api/template-libraries/${libraryId}/members/${owner.id}`,
        { role: "reader" },
      )
    ).statusCode,
    409,
  );

  const ownerRelease = await release(ownerCookie, "Owner template");
  const curatorRelease = await release(curatorCookie, "Curator template");
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/publications`,
        { releaseId: ownerRelease.releaseId },
        curatorCookie,
      )
    ).statusCode,
    404,
  );
  const published = await call(
    "POST",
    `/api/template-libraries/${libraryId}/publications`,
    { releaseId: curatorRelease.releaseId },
    curatorCookie,
  );
  assert.equal(published.statusCode, 200, published.body);
  // Library administration does not authorize publishing another owner's source.
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/publications`,
        { releaseId: curatorRelease.releaseId },
        ownerCookie,
      )
    ).statusCode,
    404,
  );
  const retried = await call(
    "POST",
    `/api/template-libraries/${libraryId}/publications`,
    { releaseId: curatorRelease.releaseId },
    curatorCookie,
  );
  assert.equal(retried.json().id, published.json().id);
  assert.equal(
    (
      await call(
        "GET",
        `/api/template-libraries/${libraryId}/publications`,
        undefined,
        ownerCookie,
      )
    ).json().items[0].revisionId,
    curatorRelease.revisionId,
  );

  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/publications/${published.json().id}/withdraw`,
        { reason: "Not authorized" },
        outsiderCookie,
      )
    ).statusCode,
    404,
  );
  const withdrawn = await call(
    "POST",
    `/api/template-libraries/${libraryId}/publications/${published.json().id}/withdraw`,
    { reason: "Superseded" },
    ownerCookie,
  );
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/publications/${published.json().id}/withdraw`,
        { reason: "Retry" },
        curatorCookie,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call("GET", `/api/template-libraries/${libraryId}/publications`)
    ).json().items.length,
    0,
  );

  const firstEvents = await call(
    "GET",
    `/api/template-libraries/${libraryId}/events?limit=2`,
  );
  assert.equal(firstEvents.statusCode, 200, firstEvents.body);
  assert.equal(firstEvents.json().items.length, 2);
  assert.ok(firstEvents.json().nextBefore);
  const secondEvents = await call(
    "GET",
    `/api/template-libraries/${libraryId}/events?limit=2&before=${firstEvents.json().nextBefore}`,
  );
  assert.equal(secondEvents.statusCode, 200, secondEvents.body);
  const beforeRevoke = [
    ...firstEvents.json().items,
    ...secondEvents.json().items,
  ];
  assert.deepEqual(
    beforeRevoke.map((event: any) => event.action),
    [
      "template_library.publication_withdrawn",
      "template_library.release_published",
      "template_library.member_role_changed",
      "template_library.created",
    ],
  );
  assert.deepEqual(beforeRevoke[2].target, {
    type: "account",
    id: curator.id,
    deleted: false,
  });
  assert.equal(beforeRevoke[2].oldRole, "reader");
  assert.equal(beforeRevoke[2].newRole, "curator");
  assert.equal(
    beforeRevoke.every((event: any) => event.libraryId === libraryId),
    true,
  );
  assert.equal(
    (await call("GET", `/api/template-libraries/${libraryId}/events?limit=101`))
      .statusCode,
    400,
  );

  const revoked = await call(
    "POST",
    `/api/template-libraries/${libraryId}/members/${curator.id}/revoke`,
    {},
  );
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/members/${curator.id}/revoke`,
        {},
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call("GET", "/api/template-libraries", undefined, curatorCookie)
    ).json().items.length,
    0,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/api/template-libraries/${libraryId}/events`,
        undefined,
        curatorCookie,
      )
    ).statusCode,
    404,
  );
  const finalEvents = (
    await call("GET", `/api/template-libraries/${libraryId}/events`)
  ).json().items;
  assert.equal(finalEvents[0].action, "template_library.member_revoked");
  assert.equal(
    finalEvents.filter(
      (event: any) => event.action === "template_library.member_revoked",
    ).length,
    1,
  );
  assert.equal(
    Number(
      (
        await db.query(
          `SELECT count(*) FROM audit_outbox
            WHERE tenant_id=$1 AND actor_id=$2 AND action LIKE 'template_library.%'`,
          [owner.tenant, owner.id],
        )
      ).rows[0].count,
    ) >= 3,
    true,
  );
});

test("disabled administrators do not satisfy the last-active-admin guard", async () => {
  const created = await call("POST", "/api/template-libraries", {
    name: "Admin guard",
  });
  const libraryId = created.json().id as string;
  await db.query(
    "INSERT INTO template_library_members(library_id,account_id,role) VALUES($1,$2,'admin')",
    [libraryId, outsider.id],
  );
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [
    outsider.id,
  ]);
  try {
    assert.equal(
      (
        await call(
          "PATCH",
          `/api/template-libraries/${libraryId}/members/${owner.id}`,
          { role: "reader" },
        )
      ).statusCode,
      409,
    );
  } finally {
    await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [
      outsider.id,
    ]);
  }
});
