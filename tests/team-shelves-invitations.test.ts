// Invitation links to a department shelf (docs/specs/TEAM_SHELVES.md,
// «Приглашение ссылкой»): issued by the admin or a curator, accepted by a
// person who had never signed in when the link was made, revocable, limited
// in time and uses, never above the issuer's own right to hand out roles.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const teamShelves = config.TEAM_SHELVES;
type Account = Awaited<ReturnType<typeof createAccount>>;
let admin: Account, curator: Account, author: Account, stranger: Account;
let shelf: { id: string; name: string };
const sessions = new Map<string, string>();
const suffix = randomBytes(5).toString("hex");

const call = (method: any, url: string, account: Account, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: { origin, cookie: `polka_session=${sessions.get(account.name)}` },
    payload: body as any,
  });

async function signUp(name: string) {
  const account = await createAccount(`${name}-${suffix}`, password);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: account.name, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  sessions.set(account.name, login.cookies[0].value);
  return account;
}

/** The link's secret, as the web page reads it from the fragment. */
const tokenOf = (url: string) => {
  const fragment = new URLSearchParams(new URL(url).hash.slice(1));
  assert.equal(fragment.get("shelfId"), shelf.id);
  return fragment.get("token")!;
};

const invite = (account: Account, body: Record<string, unknown>) =>
  call("POST", `/api/shelves/${shelf.id}/invitations`, account, body);
const accept = (account: Account, token: string, shelfId = shelf.id) =>
  call("POST", `/api/shelves/${shelfId}/invitations/accept`, account, { token });
const roleOn = async (account: Account) =>
  (
    await db.query(
      "SELECT role FROM tenant_members WHERE tenant_id=$1 AND account_id=$2 AND state='active'",
      [shelf.id, account.id],
    )
  ).rows[0]?.role ?? null;

before(async () => {
  config.TEAM_SHELVES = "on";
  admin = await signUp("inv-admin");
  curator = await signUp("inv-curator");
  author = await signUp("inv-author");
  stranger = await signUp("inv-stranger");
  await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [admin.id]);
  shelf = (await call("POST", "/api/shelves", admin, { name: "Отдел закупок" })).json();
  for (const [account, role] of [[curator, "curator"], [author, "author"]] as const) {
    const added = await call("POST", `/api/shelves/${shelf.id}/members`, admin, { who: account.name, role });
    assert.equal(added.statusCode, 200, added.body);
  }
});

after(async () => {
  config.TEAM_SHELVES = teamShelves;
  await app.close();
  await db.end();
  s3.destroy();
});

test("someone who had never signed in joins by the link with its role", async () => {
  const created = await invite(admin, { role: "curator", expiresInHours: 24 });
  assert.equal(created.statusCode, 200, created.body);
  const link = created.json();
  assert.equal(link.role, "curator");
  assert.equal(link.maxUses, 1);
  assert.match(link.invitationUrl, new RegExp(`^${origin}/shelf-invite#`));
  const token = tokenOf(link.invitationUrl);
  // Only the hash is stored.
  const stored = (await db.query("SELECT token_hash FROM tenant_invitations WHERE id=$1", [link.id])).rows[0];
  assert.notEqual(stored.token_hash, token);

  // The newcomer signs up after the link was made.
  const newcomer = await signUp("inv-newcomer");
  const joined = await accept(newcomer, token);
  assert.equal(joined.statusCode, 200, joined.body);
  assert.deepEqual(joined.json(), { shelfId: shelf.id, name: "Отдел закупок", role: "curator", joined: true });
  assert.equal(await roleOn(newcomer), "curator");
  // The shelf is now among the newcomer's shelves and opens by its header.
  const shelves = (await call("GET", "/api/shelves", newcomer)).json().items;
  assert.ok(shelves.some((item: any) => item.id === shelf.id && item.role === "curator"));

  // Opening the link again changes nothing; a second person cannot use it.
  const again = await accept(newcomer, token);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().joined, false);
  const second = await signUp("inv-second");
  const used = await accept(second, token);
  assert.equal(used.statusCode, 409, used.body);
  assert.match(used.json().message ?? used.body, /использовано/);
  assert.equal(await roleOn(second), null);

  const list = (await call("GET", `/api/shelves/${shelf.id}/invitations`, admin)).json().items;
  const row = list.find((item: any) => item.id === link.id);
  assert.equal(row.status, "used");
  assert.equal(row.uses, 1);
  assert.equal(row.invitationUrl, undefined);

  // The journal says who issued the link and who came by it.
  const events = (await db.query(
    "SELECT action,actor_id,target_account_id,new_role FROM tenant_member_events WHERE invitation_id=$1 ORDER BY id",
    [link.id],
  )).rows;
  assert.deepEqual(events, [
    { action: "invitation_created", actor_id: admin.id, target_account_id: null, new_role: "curator" },
    { action: "invitation_accepted", actor_id: newcomer.id, target_account_id: newcomer.id, new_role: "curator" },
  ]);
  const journal = (await call("GET", `/api/shelves/${shelf.id}/events`, admin)).json().items;
  assert.equal(journal[0].action, "invitation_accepted");
});

test("a link for several people counts its uses", async () => {
  const link = (await invite(admin, { role: "reader", maxUses: 2 })).json();
  const token = tokenOf(link.invitationUrl);
  const one = await signUp("inv-many-1");
  const two = await signUp("inv-many-2");
  const three = await signUp("inv-many-3");
  assert.equal((await accept(one, token)).statusCode, 200);
  // Already a member: no use is spent.
  assert.equal((await accept(curator, token)).json().role, "curator");
  assert.equal((await accept(two, token)).statusCode, 200);
  assert.equal((await accept(three, token)).statusCode, 409);
  assert.equal(await roleOn(one), "reader");
  assert.equal(await roleOn(two), "reader");
});

test("an expired or revoked link admits nobody", async () => {
  const expired = (await invite(admin, { role: "author", expiresInHours: 1 })).json();
  await db.query(
    "UPDATE tenant_invitations SET created_at=created_at-interval '2 hours',expires_at=expires_at-interval '2 hours' WHERE id=$1",
    [expired.id],
  );
  const late = await signUp("inv-late");
  const refused = await accept(late, tokenOf(expired.invitationUrl));
  assert.equal(refused.statusCode, 409, refused.body);
  assert.match(refused.body, /истёк/);
  assert.equal(await roleOn(late), null);

  const revoked = (await invite(curator, { role: "author" })).json();
  // Only the shelf's admin and curators touch links: an author does not, a
  // stranger does not even see the shelf.
  assert.equal(
    (await call("POST", `/api/shelves/${shelf.id}/invitations/${revoked.id}/revoke`, author)).statusCode,
    403,
  );
  assert.equal(
    (await call("POST", `/api/shelves/${shelf.id}/invitations/${revoked.id}/revoke`, stranger)).statusCode,
    404,
  );
  const off = await call("POST", `/api/shelves/${shelf.id}/invitations/${revoked.id}/revoke`, admin);
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(
    (await db.query("SELECT state,token_hash FROM tenant_invitations WHERE id=$1", [revoked.id])).rows[0].token_hash,
    null,
  );
  // The secret is forgotten, so the link is simply not found.
  const gone = await accept(late, tokenOf(revoked.invitationUrl));
  assert.equal(gone.statusCode, 404, gone.body);
  assert.equal(await roleOn(late), null);
  // Revoking twice is fine; a used link can still be revoked.
  assert.equal(
    (await call("POST", `/api/shelves/${shelf.id}/invitations/${revoked.id}/revoke`, admin)).statusCode,
    200,
  );
  const status = (await call("GET", `/api/shelves/${shelf.id}/invitations`, curator)).json().items;
  assert.equal(status.find((item: any) => item.id === revoked.id).status, "revoked");
  assert.equal(status.find((item: any) => item.id === expired.id).status, "expired");
  // A token of one shelf does not open another.
  const other = (await call("POST", "/api/shelves", admin, { name: "Другой отдел" })).json();
  const elsewhere = (await invite(admin, { role: "reader" })).json();
  assert.equal((await accept(late, tokenOf(elsewhere.invitationUrl), other.id)).statusCode, 404);
});

test("nobody hands out more than they may", async () => {
  // Never admin by link; a curator invites readers and authors only.
  assert.equal((await invite(admin, { role: "admin" })).statusCode, 400);
  const escalation = await invite(curator, { role: "curator" });
  assert.equal(escalation.statusCode, 403, escalation.body);
  assert.match(escalation.body, /Кураторов приглашает администратор/);
  assert.equal((await invite(curator, { role: "author" })).statusCode, 200);
  assert.equal((await invite(author, { role: "reader" })).statusCode, 403);
  assert.equal((await invite(stranger, { role: "reader" })).statusCode, 404);
  assert.equal((await call("GET", `/api/shelves/${shelf.id}/invitations`, author)).statusCode, 403);
  // Limits of the link itself.
  assert.equal((await invite(admin, { role: "reader", expiresInHours: 169 })).statusCode, 400);
  assert.equal((await invite(admin, { role: "reader", maxUses: 51 })).statusCode, 400);

  // A link outlives nobody's rights: once its curator becomes an author, the
  // curator's links stop working; a curator revokes only its own.
  const byCurator = (await invite(curator, { role: "reader" })).json();
  const byAdmin = (await invite(admin, { role: "reader" })).json();
  assert.equal(
    (await call("POST", `/api/shelves/${shelf.id}/invitations/${byAdmin.id}/revoke`, curator)).statusCode,
    403,
  );
  const demoted = await call("PATCH", `/api/shelves/${shelf.id}/members/${curator.id}`, admin, { role: "author" });
  assert.equal(demoted.statusCode, 200, demoted.body);
  const latecomer = await signUp("inv-after-demotion");
  const dead = await accept(latecomer, tokenOf(byCurator.invitationUrl));
  assert.equal(dead.statusCode, 409, dead.body);
  assert.equal(await roleOn(latecomer), null);
  assert.equal((await accept(latecomer, tokenOf(byAdmin.invitationUrl))).statusCode, 200);
  await call("PATCH", `/api/shelves/${shelf.id}/members/${curator.id}`, admin, { role: "curator" });
});

test("a provisional shelf cannot join, and with TEAM_SHELVES off nothing opens", async () => {
  const link = (await invite(admin, { role: "reader", maxUses: 3 })).json();
  const token = tokenOf(link.invitationUrl);
  const guest = await signUp("inv-guest");
  await db.query("UPDATE accounts SET provisional_at=now() WHERE id=$1", [guest.id]);
  const refused = await accept(guest, token);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(await roleOn(guest), null);

  config.TEAM_SHELVES = "off";
  try {
    const closed = await accept(stranger, token);
    assert.equal(closed.statusCode, 404, closed.body);
    assert.equal((await invite(admin, { role: "reader" })).statusCode, 404);
  } finally {
    config.TEAM_SHELVES = "on";
  }
  assert.equal((await accept(stranger, token)).statusCode, 200);
});
