import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const password = randomBytes(24).toString("hex");
let admin: Awaited<ReturnType<typeof createAccount>>;
let recipient: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;
let adminCookie = "";
let recipientCookie = "";
let otherCookie = "";
const recipientEmail = `recipient-${randomBytes(5).toString("hex")}@example.test`;
const otherEmail = `other-${randomBytes(5).toString("hex")}@example.test`;

async function call(
  method: string,
  url: string,
  body?: Record<string, unknown>,
  cookie = adminCookie,
) {
  return app.inject({
    method: method as any,
    url,
    headers: { origin: config.APP_ORIGIN, ...(cookie ? { cookie } : {}) },
    payload: body,
  });
}

async function login(name: string) {
  const response = await call("POST", "/api/login", { name, password }, "");
  assert.equal(response.statusCode, 200, response.body);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

async function library(name: string) {
  const response = await call("POST", "/api/template-libraries", { name });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().id as string;
}

async function invite(
  libraryId: string,
  email = recipientEmail,
  extra: Record<string, unknown> = {},
) {
  const response = await call(
    "POST",
    `/api/template-libraries/${libraryId}/invitations`,
    {
      email,
      ...extra,
    },
  );
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  const url = new URL(result.invitationUrl);
  assert.equal(url.search, "");
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(fragment.get("libraryId"), libraryId);
  assert.ok(fragment.get("token"));
  return { ...result, token: fragment.get("token") as string };
}

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  admin = await createAccount(`invite-admin-${suffix}`, password);
  recipient = await createAccount(`invite-recipient-${suffix}`, password);
  other = await createAccount(`invite-other-${suffix}`, password);
  await db.query(
    `UPDATE accounts SET email=CASE id WHEN $1 THEN $2 WHEN $3 THEN $4 END,
                         email_verified_at=CASE WHEN id=$1 THEN NULL ELSE now() END
      WHERE id IN ($1,$3)`,
    [recipient.id, recipientEmail, other.id, otherEmail],
  );
  adminCookie = await login(admin.name);
  recipientCookie = await login(recipient.name);
  otherCookie = await login(other.name);
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("admin creates, lists, revokes, and accepts only bounded email invitations", async () => {
  const libraryId = await library("Invite boundaries");
  const created = await invite(
    libraryId,
    `  ${recipientEmail.toUpperCase()}  `,
  );
  assert.equal(created.email, recipientEmail);
  assert.equal(created.role, "reader");
  assert.equal(
    sha256(created.token),
    (
      await db.query(
        "SELECT token_hash FROM template_library_invitations WHERE id=$1",
        [created.id],
      )
    ).rows[0].token_hash,
  );
  const listed = await call(
    "GET",
    `/api/template-libraries/${libraryId}/invitations`,
  );
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().items[0].status, "pending");
  assert.equal(listed.body.includes(created.token), false);
  assert.equal(listed.body.includes("token_hash"), false);
  assert.equal(
    (
      await call(
        "GET",
        `/api/template-libraries/${libraryId}/invitations`,
        undefined,
        otherCookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call("POST", `/api/template-libraries/${libraryId}/invitations`, {
        email: otherEmail,
        expiresInHours: 169,
      })
    ).statusCode,
    400,
  );

  const revoked = await invite(libraryId, otherEmail, {
    role: "curator",
    expiresInHours: 1,
  });
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/invitations/${revoked.id}/revoke`,
        {},
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/invitations/accept`,
        { token: revoked.token },
        otherCookie,
      )
    ).statusCode,
    404,
  );

  const unverified = await call(
    "POST",
    `/api/template-libraries/${libraryId}/invitations/accept`,
    { token: created.token },
    recipientCookie,
  );
  assert.equal(unverified.statusCode, 403, unverified.body);
  assert.match(unverified.json().message, /подтвердите/i);
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/invitations/accept`,
        { token: created.token },
        otherCookie,
      )
    ).statusCode,
    403,
  );
  await db.query("UPDATE accounts SET email_verified_at=now() WHERE id=$1", [
    recipient.id,
  ]);
  const accepted = await call(
    "POST",
    `/api/template-libraries/${libraryId}/invitations/accept`,
    { token: created.token },
    recipientCookie,
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().role, "reader");
  const retry = await call(
    "POST",
    `/api/template-libraries/${libraryId}/invitations/accept`,
    { token: created.token },
    recipientCookie,
  );
  assert.equal(retry.statusCode, 200, retry.body);
  const events = (
    await call("GET", `/api/template-libraries/${libraryId}/events`)
  ).json().items;
  assert.deepEqual(
    events.map((event: any) => event.action),
    [
      "template_library.invitation_accepted",
      "template_library.invitation_revoked",
      "template_library.invitation_created",
      "template_library.invitation_created",
      "template_library.created",
    ],
  );
  assert.equal(
    events.filter(
      (event: any) => event.action === "template_library.invitation_accepted",
    ).length,
    1,
  );
  assert.deepEqual(events[0].target, {
    type: "account",
    id: recipient.id,
    deleted: false,
  });
  assert.equal(events[0].newRole, "reader");
  assert.equal(events[1].oldRole, "curator");
  assert.equal(events[1].newRole, null);
});

test("old invite cannot restore revoked access and a new invite creates a new epoch", async () => {
  const libraryId = await library("Membership epochs");
  const first = await invite(libraryId, recipientEmail, { role: "curator" });
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/invitations/accept`,
        { token: first.token },
        recipientCookie,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/members/${recipient.id}/revoke`,
        {},
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/invitations/accept`,
        { token: first.token },
        recipientCookie,
      )
    ).statusCode,
    409,
  );
  const second = await invite(libraryId, recipientEmail, { role: "admin" });
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/invitations/accept`,
        { token: second.token },
        recipientCookie,
      )
    ).json().role,
    "admin",
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM template_library_members WHERE library_id=$1 AND account_id=$2",
          [libraryId, recipient.id],
        )
      ).rows[0].count,
    ),
    2,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/invitations/accept`,
        { token: first.token },
        recipientCookie,
      )
    ).statusCode,
    409,
  );
});

test("acceptance rejects expiry, another library, and an issuer who lost admin role", async () => {
  const libraryId = await library("Invalidation");
  const otherLibraryId = await library("Cross-library");
  const expired = await invite(libraryId, otherEmail);
  await db.query(
    `UPDATE template_library_invitations
        SET created_at=clock_timestamp()-interval '2 hours',
            expires_at=clock_timestamp()-interval '1 hour'
      WHERE id=$1`,
    [expired.id],
  );
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/invitations/accept`,
        { token: expired.token },
        otherCookie,
      )
    ).statusCode,
    409,
  );
  const scoped = await invite(libraryId, otherEmail);
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${otherLibraryId}/invitations/accept`,
        { token: scoped.token },
        otherCookie,
      )
    ).statusCode,
    404,
  );
  await db.query(
    `UPDATE template_library_members SET role='reader'
      WHERE library_id=$1 AND account_id=$2 AND state='active'`,
    [libraryId, admin.id],
  );
  assert.equal(
    (
      await call(
        "POST",
        `/api/template-libraries/${libraryId}/invitations/accept`,
        { token: scoped.token },
        otherCookie,
      )
    ).statusCode,
    409,
  );
});

test("account anonymization clears pending and accepted invitation identity", async () => {
  const pendingLibrary = await library("Purge pending");
  const pending = await invite(pendingLibrary, otherEmail);
  await db.query(
    "UPDATE accounts SET email=NULL,email_verified_at=NULL WHERE id=$1",
    [other.id],
  );
  const pendingRow = (
    await db.query(
      "SELECT state,email,token_hash,accepted_by FROM template_library_invitations WHERE id=$1",
      [pending.id],
    )
  ).rows[0];
  assert.deepEqual(pendingRow, {
    state: "redacted",
    email: null,
    token_hash: null,
    accepted_by: null,
  });

  const acceptedLibrary = await library("Purge accepted");
  const accepted = await invite(acceptedLibrary, recipientEmail);
  await call(
    "POST",
    `/api/template-libraries/${acceptedLibrary}/invitations/accept`,
    { token: accepted.token },
    recipientCookie,
  );
  await db.query(
    "DELETE FROM template_library_members WHERE library_id=$1 AND account_id=$2",
    [acceptedLibrary, recipient.id],
  );
  const acceptedRow = (
    await db.query(
      `SELECT state,email,token_hash,accepted_by,accepted_membership_joined_at
         FROM template_library_invitations WHERE id=$1`,
      [accepted.id],
    )
  ).rows[0];
  assert.deepEqual(acceptedRow, {
    state: "redacted",
    email: null,
    token_hash: null,
    accepted_by: null,
    accepted_membership_joined_at: null,
  });
});
