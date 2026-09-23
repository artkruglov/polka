import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createAccount } from "../apps/server/auth.ts";
import { tokenFor } from "../apps/server/artifacts.ts";
import { db, transaction } from "../apps/server/db.ts";
import {
  ModerationError,
  clean,
  disableAccount,
  enableAccount,
  formatDisabled,
  formatEnabled,
  formatReports,
  formatRevokedShare,
  listReports,
  revokeShareAsOperator,
} from "../apps/server/moderation.ts";
import {
  assertActiveOwner,
  lockActiveOwnerTenant,
} from "../apps/server/owner-state.ts";
import { reportShare } from "../apps/server/reports.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

type Account = Awaited<ReturnType<typeof createAccount>>;
const password = randomBytes(24).toString("hex");

after(async () => {
  await db.end();
  s3.destroy();
});

async function account(prefix: string, email?: string) {
  const created = await createAccount(
    `${prefix}-${randomBytes(4).toString("hex")}`,
    password,
  );
  if (email)
    await db.query("UPDATE accounts SET email=$2 WHERE id=$1", [
      created.id,
      email,
    ]);
  return created;
}

async function sharedArtifact(owner: Account, title: string, days = 7) {
  const artifactId = randomUUID(),
    revisionId = randomUUID(),
    shareId = randomUUID();
  await db.query(
    "INSERT INTO artifacts(id,tenant_id,created_by,title) VALUES($1,$2,$3,$4)",
    [artifactId, owner.tenant, owner.id, title],
  );
  await db.query(
    `INSERT INTO revisions(
       id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,
       object_key,object_version,storage_kind,total_size
     ) VALUES($1,$2,$3,1,$4,'note.txt','text/plain',4,$5,$6,'version','single',4)`,
    [
      revisionId,
      owner.tenant,
      artifactId,
      owner.id,
      sha256("note"),
      `${owner.tenant}/moderation/${revisionId}`,
    ],
  );
  await db.query("UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1", [
    artifactId,
    revisionId,
  ]);
  await db.query(
    `INSERT INTO shares(id,tenant_id,artifact_id,revision_id,token_hash,expires_at)
     VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 day')`,
    [
      shareId,
      owner.tenant,
      artifactId,
      revisionId,
      sha256(tokenFor(shareId)),
      days,
    ],
  );
  return { artifactId, revisionId, shareId, token: tokenFor(shareId) };
}

const report = (token: string, reason: string, comment?: string) =>
  reportShare(
    { key: randomUUID(), token, reason, ...(comment ? { comment } : {}) },
    `203.0.113.${Math.floor(Math.random() * 250)}`,
  );

async function session(owner: Account) {
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [sha256(randomBytes(32)), owner.id],
  );
}

async function tokenConnection(owner: Account) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_connections(
       id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at
     ) VALUES($1,$2,$3,$4,'moderation token',$5,$6,now()+interval '1 day')`,
    [
      id,
      owner.tenant,
      owner.id,
      sha256(randomBytes(32)),
      ["read"],
      MCP_AUDIENCE,
    ],
  );
  return id;
}

async function oauthConnection(owner: Account) {
  const clientId = "pc_" + randomBytes(16).toString("base64url").slice(0, 22);
  await db.query(
    `INSERT INTO oauth_clients(client_id,auth_method,client_name,redirect_uris,grant_types)
     VALUES($1,'none','moderation client',$2,$3)`,
    [
      clientId,
      ["https://client.example/callback"],
      ["authorization_code", "refresh_token"],
    ],
  );
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_connections(
       id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at,
       oauth_client_id,access_expires_at
     ) VALUES($1,$2,$3,$4,'moderation oauth',$5,$6,now()+interval '30 days',
       $7,now()+interval '1 hour')`,
    [
      id,
      owner.tenant,
      owner.id,
      sha256(randomBytes(32)),
      ["read"],
      MCP_AUDIENCE,
      clientId,
    ],
  );
  await db.query(
    `INSERT INTO oauth_refresh_tokens(
       id,connection_id,tenant_id,account_id,client_id,token_hash,expires_at
     ) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 days')`,
    [
      randomUUID(),
      id,
      owner.tenant,
      owner.id,
      clientId,
      sha256(randomBytes(32)),
    ],
  );
  return id;
}

// scripts/test-runtime-grants-isolated.ts reruns this file as the runtime role.
test("runs as the expected database role", async () => {
  const expected = process.env.RUNTIME_GRANTS_EXPECT_ROLE;
  if (!expected) return;
  const {
    rows: [identity],
  } = await db.query("SELECT current_user,session_user");
  assert.deepEqual(identity, {
    current_user: expected,
    session_user: expected,
  });
});

const actions = async (owner: Account) =>
  (
    await db.query(
      "SELECT action FROM audit_outbox WHERE tenant_id=$1 ORDER BY id",
      [owner.tenant],
    )
  ).rows.map((row) => row.action);

test("reports list newest first with owner, share state and counts", async () => {
  const owner = await account(
    "mod-list",
    `list-${randomBytes(4).toString("hex")}@example.com`,
  );
  const first = await sharedArtifact(owner, "Первый\u001b[31m отчёт");
  const second = await sharedArtifact(owner, "Второй");
  await report(first.token, "phishing", "похоже на\nфишинг " + "x".repeat(200));
  await report(first.token, "malware");
  await report(second.token, "other", "третья жалоба");
  await db.query(
    "UPDATE share_reports SET created_at=now()-interval '10 days' WHERE share_id=$1 AND reason='malware'",
    [first.shareId],
  );
  await db.query("UPDATE shares SET revoked=true WHERE id=$1", [
    second.shareId,
  ]);

  const result = await listReports(7);
  const mine = result.reports.filter((row) =>
    [first.shareId, second.shareId as string].includes(row.shareId),
  );
  assert.deepEqual(
    mine.map((row) => [row.shareId, row.reason, row.shareActive]),
    [
      [second.shareId, "other", false],
      [first.shareId, "phishing", true],
    ],
  );
  assert.equal(mine[1].shareReports, 2, "all-time count per share");
  assert.equal(mine[1].ownerReports, 3, "all-time count per owner");
  assert.equal(mine[1].artifactId, first.artifactId);
  assert.equal(mine[1].ownerName, owner.name);

  const wide = await listReports(30);
  assert.ok(
    wide.reports.some(
      (row) => row.reason === "malware" && row.shareId === first.shareId,
    ),
  );

  const text = formatReports({ ...result, reports: mine });
  const lines = text.split("\n");
  assert.match(lines[0], /^REPORTED \(UTC\)\s+REASON\s+SHARE\s+LIVE/);
  assert.ok(lines[1].includes(second.shareId) && / no /.test(lines[1]));
  assert.ok(lines[2].includes(first.shareId) && / yes /.test(lines[2]));
  assert.ok(lines[2].includes(owner.name) && lines[2].includes("@example.com"));
  assert.ok(
    !text.includes("\u001b"),
    "control characters never reach the terminal",
  );
  assert.ok(lines[2].includes("похоже на фишинг") && lines[2].endsWith("…"));
  assert.ok(!text.includes(first.token) && !text.includes(second.token));
  assert.match(text, /2 report\(s\) in the last 7 day\(s\)/);
  assert.equal(
    formatReports({ days: 3, truncated: false, reports: [] }),
    "No reports in the last 3 day(s).",
  );
  await assert.rejects(listReports(0), ModerationError);
  await assert.rejects(listReports(Number.NaN), ModerationError);
  assert.equal(clean("a\u202eb\tc  d", 10), "a b c d");
});

test("revoke-share closes one share through the owner revoke path", async () => {
  const owner = await account("mod-share");
  const target = await sharedArtifact(owner, "Спорная страница");
  const other = await sharedArtifact(owner, "Соседняя страница");

  const result = await revokeShareAsOperator(target.shareId);
  assert.equal(result.wasActive, true);
  assert.equal(result.alreadyRevoked, false);
  assert.equal(result.artifactId, target.artifactId);
  const text = formatRevokedShare(result);
  assert.match(text, /was live and is now closed/);
  assert.ok(text.includes("Спорная страница") && text.includes(owner.name));
  assert.ok(!text.includes(target.token));

  const states = (
    await db.query("SELECT id,revoked FROM shares WHERE tenant_id=$1", [
      owner.tenant,
    ])
  ).rows;
  assert.deepEqual(
    Object.fromEntries(states.map((row) => [row.id, row.revoked])),
    { [target.shareId]: true, [other.shareId]: false },
  );
  assert.deepEqual(await actions(owner), ["share.revoked"]);

  const again = await revokeShareAsOperator(target.shareId);
  assert.equal(again.alreadyRevoked, true);
  assert.match(formatRevokedShare(again), /already closed; nothing changed/);
  assert.deepEqual(await actions(owner), ["share.revoked"]);

  // A disabled owner's share can still be closed by the operator.
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [owner.id]);
  assert.equal((await revokeShareAsOperator(other.shareId)).wasActive, true);

  await assert.rejects(revokeShareAsOperator(randomUUID()), /No share/);
  await assert.rejects(revokeShareAsOperator("not-a-uuid"), /Not a share id/);
});

test("disable ends sessions, revokes connections and closes shares without deleting data", async () => {
  const email = `mod-off-${randomUUID()}@example.com`;
  const owner = await account("mod-off", email);
  const bystander = await account("mod-by");
  const live = await sharedArtifact(owner, "Живая");
  const expired = await sharedArtifact(owner, "Истёкшая", 1);
  await db.query(
    "UPDATE shares SET expires_at=now()-interval '1 hour' WHERE id=$1",
    [expired.shareId],
  );
  const kept = await sharedArtifact(bystander, "Чужая");
  await session(owner);
  await session(owner);
  await session(bystander);
  const token = await tokenConnection(owner);
  const oauth = await oauthConnection(owner);
  const bystanderConnection = await tokenConnection(bystander);

  const result = await disableAccount(email.toUpperCase(), "фишинг по жалобам");
  assert.deepEqual(result, {
    name: owner.name,
    email,
    alreadyDisabled: false,
    reason: "фишинг по жалобам",
    sessions: 2,
    tokenConnections: 1,
    oauthConnections: 1,
    liveShares: 1,
    expiredShares: 1,
  });
  const text = formatDisabled(result);
  assert.match(text, /is disabled\./);
  assert.match(text, /Reason: фишинг по жалобам/);
  assert.match(text, /Agent connections revoked: 2 \(token 1, OAuth 1\)/);
  assert.match(text, /Shares closed: 2 \(live 1, expired 1\)/);

  const accountRow = (
    await db.query(
      "SELECT disabled,deletion_requested_at FROM accounts WHERE id=$1",
      [owner.id],
    )
  ).rows[0];
  assert.deepEqual(accountRow, { disabled: true, deletion_requested_at: null });
  const count = async (sql: string, params: unknown[]) =>
    Number((await db.query(sql, params)).rows[0].count);
  assert.equal(
    await count("SELECT count(*) FROM sessions WHERE account_id=$1", [
      owner.id,
    ]),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM agent_connections WHERE tenant_id=$1 AND revoked_at IS NULL",
      [owner.tenant],
    ),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM oauth_refresh_tokens WHERE connection_id=$1 AND revoked_at IS NULL",
      [oauth],
    ),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM shares WHERE tenant_id=$1 AND NOT revoked",
      [owner.tenant],
    ),
    0,
  );
  assert.equal(
    await count("SELECT count(*) FROM artifacts WHERE tenant_id=$1", [
      owner.tenant,
    ]),
    2,
  );
  assert.equal(
    await count("SELECT count(*) FROM revisions WHERE tenant_id=$1", [
      owner.tenant,
    ]),
    2,
  );
  assert.deepEqual((await actions(owner)).sort(), [
    "account.disabled",
    "agent.connection.revoked",
    "agent.connection.revoked",
    "share.revoked",
    "share.revoked",
  ]);
  assert.ok(token);

  // The product's own owner checks now refuse the account.
  const actor = { id: owner.id, tenant: owner.tenant };
  await assert.rejects(
    assertActiveOwner(db, actor),
    (error: any) => error?.status === 403,
  );
  await assert.rejects(transaction((c) => lockActiveOwnerTenant(c, actor)));

  // Nobody else is touched.
  assert.equal(
    await count("SELECT count(*) FROM sessions WHERE account_id=$1", [
      bystander.id,
    ]),
    1,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM agent_connections WHERE id=$1 AND revoked_at IS NULL",
      [bystanderConnection],
    ),
    1,
  );
  assert.equal(
    await count("SELECT count(*) FROM shares WHERE id=$1 AND NOT revoked", [
      kept.shareId,
    ]),
    1,
  );

  const repeat = await disableAccount(owner.name);
  assert.equal(repeat.alreadyDisabled, true);
  assert.equal(
    repeat.sessions +
      repeat.tokenConnections +
      repeat.oauthConnections +
      repeat.liveShares,
    0,
  );
  assert.match(formatDisabled(repeat), /was already disabled/);
  assert.equal(
    (await actions(owner)).filter((a) => a === "account.disabled").length,
    1,
  );
  assert.ok(live);

  await assert.rejects(disableAccount("no-such-login-xyz"), /No account/);
  await assert.rejects(disableAccount("  "), ModerationError);
});

test("enable lifts the disable but leaves shares and connections closed", async () => {
  const owner = await account("mod-on");
  const shared = await sharedArtifact(owner, "Была открыта");
  const connection = await tokenConnection(owner);
  await disableAccount(owner.name);

  const result = await enableAccount(owner.name);
  assert.deepEqual(result, {
    name: owner.name,
    email: null,
    alreadyEnabled: false,
  });
  assert.match(formatEnabled(result), /is enabled\. Closed shares/);
  await assertActiveOwner(db, { id: owner.id, tenant: owner.tenant });
  assert.equal(
    (await db.query("SELECT revoked FROM shares WHERE id=$1", [shared.shareId]))
      .rows[0].revoked,
    true,
  );
  assert.notEqual(
    (
      await db.query("SELECT revoked_at FROM agent_connections WHERE id=$1", [
        connection,
      ])
    ).rows[0].revoked_at,
    null,
  );
  assert.ok((await actions(owner)).includes("account.enabled"));

  const again = await enableAccount(owner.name);
  assert.equal(again.alreadyEnabled, true);
  assert.match(formatEnabled(again), /was not disabled; nothing changed/);

  // An account in deletion stays disabled.
  const leaving = await account("mod-del");
  await db.query(
    "UPDATE accounts SET disabled=true,deletion_requested_at=now() WHERE id=$1",
    [leaving.id],
  );
  await assert.rejects(enableAccount(leaving.name), /being deleted/);
  await assert.rejects(disableAccount(leaving.name), /being deleted/);
});
