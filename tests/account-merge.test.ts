// Merging one person's two shelves (docs/specs/SIGN_IN_PROVIDERS.md § 9,
// apps/server/account-merge.ts, scripts/account-merge.ts). The fixtures are
// the real incident: an operator-created login with an address on gmail, and
// a second shelf opened by Яндекс ID with works, links, folders, a note, an
// agent token and an OAuth connector, a library membership and analytics.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { actorKey, flushAnalytics } from "../apps/server/analytics.ts";
import { MERGE_INVENTORY, mergeAccounts, MergeRefusal, WEB_MERGE_MAX_OBJECTS } from "../apps/server/account-merge.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { useExtensions } from "../apps/server/extensions.ts";
import type { AccountMerge } from "../packages/extension-api/index.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { bucket, putImmutable, s3, sha256 } from "../apps/server/storage.ts";
import { gzipSync } from "node:zlib";
import { runAccountMerge } from "../scripts/account-merge.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const address = () => `2001:db8:4e::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

type Owner = { id: string; tenant: string; name: string };

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

async function owner(prefix: string, email?: string): Promise<Owner> {
  const created = await createAccount(`${prefix}-${randomBytes(4).toString("hex")}`, password);
  if (email) await db.query("UPDATE accounts SET email=$2,email_verified_at=now() WHERE id=$1", [created.id, email]);
  return created;
}

async function staticToken(who: Owner) {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'script',$5,$6,now()+interval '1 day')`,
    [randomUUID(), who.tenant, who.id, sha256(secret), ["context", "capture", "revise", "share"], MCP_AUDIENCE],
  );
  return secret;
}

/** An OAuth connector (Claude.ai) with a refresh token, as oauth.ts issues. */
async function connector(who: Owner) {
  const clientId = `pc_${randomBytes(16).toString("base64url").slice(0, 22)}`;
  await db.query(
    `INSERT INTO oauth_clients(client_id,auth_method,client_name,redirect_uris,grant_types)
     VALUES($1,'none','Claude',ARRAY['https://claude.ai/api/mcp/auth_callback'],
            ARRAY['authorization_code','refresh_token'])`,
    [clientId],
  );
  const connection = randomUUID();
  const access = randomBytes(32).toString("base64url");
  const refresh = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,
       expires_at,oauth_client_id,access_expires_at)
     VALUES($1,$2,$3,$4,'Claude',$5,$6,now()+interval '30 days',$7,now()+interval '1 hour')`,
    [connection, who.tenant, who.id, sha256(access), ["context", "capture", "share"], MCP_AUDIENCE, clientId],
  );
  await db.query(
    `INSERT INTO oauth_refresh_tokens(id,connection_id,tenant_id,account_id,client_id,token_hash,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 days')`,
    [randomUUID(), connection, who.tenant, who.id, clientId, sha256(refresh)],
  );
  return { clientId, connection, access, refresh };
}

// Every page differs: a blocked page's hash stops the same bytes everywhere.
const page = (heading: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title></head><body><h1>${heading}</h1><p>Сводка для владельца полки.</p><p>${randomUUID()}</p></body></html>`;

async function publish(secret: string, title: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress: address(),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    payload: JSON.stringify({
      key: randomUUID(),
      title,
      html: page(title),
      expiresInDays: 30,
    }),
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as {
    artifactId: string;
    revisionId: string;
    url: string;
    state: string;
  };
}

/** Opens a share link as a recipient and returns the page's HTML. */
async function openLink(url: string) {
  const resolved = await app.inject({
    method: "POST",
    url: "/api/resolve",
    remoteAddress: address(),
    headers: { origin },
    payload: { token: new URL(url).hash.slice(1) },
  });
  if (resolved.statusCode !== 200) return { status: resolved.statusCode };
  const { grant } = resolved.json();
  const document = await app.inject({
    method: "GET",
    url: `/api/view/${grant}/document`,
    remoteAddress: address(),
  });
  return { status: document.statusCode, body: document.body };
}

async function fixture() {
  const suffix = randomBytes(3).toString("hex");
  const into = await owner("artem", `artem.${suffix}@gmail.com`);
  const from = await owner("yandex", `artem.${suffix}@yandex.ru`);
  // Both have a folder «Отчёты»; the source also has «Черновики».
  const [intoReports, fromReports, fromDrafts] = [randomUUID(), randomUUID(), randomUUID()];
  await db.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$2,'Отчёты'),($3,$4,'Отчёты'),($5,$4,'Черновики')", [
    intoReports,
    into.tenant,
    fromReports,
    from.tenant,
    fromDrafts,
  ]);
  const intoToken = await staticToken(into);
  await publish(intoToken, "Уже на полке");
  const fromToken = await staticToken(from);
  const first = await publish(fromToken, "Отчёт за квартал");
  const second = await publish(fromToken, "Черновик письма");
  await db.query("UPDATE artifacts SET folder_id=$2 WHERE id=$1", [first.artifactId, fromReports]);
  await db.query("UPDATE artifacts SET folder_id=$2 WHERE id=$1", [second.artifactId, fromDrafts]);
  // A second version of the first work.
  const edited = await app.inject({
    method: "POST",
    url: `/api/v1/works/${first.artifactId}/edits`,
    remoteAddress: address(),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${fromToken}`,
    },
    payload: JSON.stringify({
      key: randomUUID(),
      baseRevisionId: first.revisionId,
      edits: [{ oldText: "Сводка", newText: "Итоговая сводка" }],
    }),
  });
  assert.equal(edited.statusCode, 200, edited.body);
  // The owner's note on the first link.
  const {
    rows: [share],
  } = await db.query("SELECT id,revision_id FROM shares WHERE artifact_id=$1 AND NOT revoked", [first.artifactId]);
  await db.query(
    `INSERT INTO comments(id,tenant_id,artifact_id,share_id,revision_id,author_account_id,body)
     VALUES($1,$2,$3,$4,$5,$6,'Проверить цифры')`,
    [randomUUID(), from.tenant, first.artifactId, share.id, share.revision_id, from.id],
  );
  await db.query(
    `INSERT INTO comment_reactions(id,tenant_id,artifact_id,share_id,revision_id,author_account_id,anchor_sig,emoji)
     VALUES($1,$2,$3,$4,$5,$6,'',$7)`,
    [randomUUID(), from.tenant, first.artifactId, share.id, share.revision_id, from.id, "\u{1F44D}"],
  );
  const oauth = await connector(from);
  await db.query(
    `INSERT INTO account_identities(id,account_id,provider,subject,email,email_verified)
     VALUES($1,$2,'yandex',$3,$4,true)`,
    [randomUUID(), from.id, `ya-${suffix}`, `artem.${suffix}@yandex.ru`],
  );
  const library = randomUUID();
  await db.query("INSERT INTO template_libraries(id,name,created_by) VALUES($1,'Шаблоны отдела',$2)", [
    library,
    from.id,
  ]);
  await db.query(
    "INSERT INTO template_library_members(library_id,account_id,role,state) VALUES($1,$2,'admin','active')",
    [library, from.id],
  );
  const session = randomBytes(32).toString("base64url");
  await db.query("INSERT INTO sessions VALUES($1,$2,now()+interval '1 day')", [sha256(session), from.id]);
  await flushAnalytics();
  return {
    into,
    from,
    intoEmail: `artem.${suffix}@gmail.com`,
    subject: `ya-${suffix}`,
    intoReports,
    fromToken,
    first,
    second,
    oauth,
    library,
    session,
  };
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

const tenantOf = async (artifactId: string) =>
  (await db.query("SELECT tenant_id FROM artifacts WHERE id=$1", [artifactId])).rows[0].tenant_id as string;

test("a dry run prints what would move and changes nothing", async () => {
  const f = await fixture();
  const report = await mergeAccounts({
    from: f.from.name,
    into: f.into.name,
    dryRun: true,
    actor: "operator-script",
  });
  assert.equal(report.dryRun, true);
  assert.equal(report.counts.artifacts, 2);
  assert.equal(report.counts.revisions, 3);
  assert.equal(report.counts.folders, 2);
  assert.equal(report.counts.foldersJoined, 1);
  assert.equal(report.counts.activeShares, 2);
  assert.equal(report.counts.discussions, 1);
  assert.equal(report.counts.activeAgentConnections, 2);
  assert.equal(report.counts.refreshTokens, 1);
  assert.equal(report.counts.identities, 1);
  assert.equal(report.counts.libraryMemberships, 1);
  assert.ok(report.counts.objects >= 3);
  assert.ok(report.counts.analyticsEvents > 0);
  assert.equal(await tenantOf(f.first.artifactId), f.from.tenant);
  assert.ok(
    report.notes.some((note) => note.includes(`@yandex.ru`)),
    "the address that stays with the source is named",
  );
  // The command prints the same counts.
  const printed: string[] = [];
  const log = console.log;
  console.log = (line: string) => printed.push(line);
  try {
    assert.equal(await runAccountMerge(["--from", f.from.id, "--into", f.intoEmail, "--dry-run"]), 0);
  } finally {
    console.log = log;
  }
  assert.match(printed.join("\n"), /Пробный прогон/);
  assert.match(printed.join("\n"), /Работы: 2, версии: 3/);
  assert.equal(await tenantOf(f.first.artifactId), f.from.tenant);
});

test("a merge moves everything; old links open, tokens keep working, the source is closed", async () => {
  const f = await fixture();
  const before = (await db.query("SELECT object_key,object_version FROM revisions WHERE tenant_id=$1", [f.from.tenant]))
    .rows;
  const sourceKey = actorKey(f.from.id);
  // Without evidence that one person owns both, nothing happens (В5).
  await assert.rejects(mergeAccounts({ from: f.from.name, into: f.into.id, actor: "operator-script" }), /--proof/);
  assert.equal(await tenantOf(f.first.artifactId), f.from.tenant);
  const report = await mergeAccounts({
    from: f.from.name,
    into: f.into.id,
    actor: "operator-script",
    reason: "одна полка",
    proof: "обращение №1042",
  });
  assert.equal(report.dryRun, false);
  assert.deepEqual(report.leftovers, []);

  // Works, versions, folders.
  assert.equal(await tenantOf(f.first.artifactId), f.into.tenant);
  assert.equal(await tenantOf(f.second.artifactId), f.into.tenant);
  const {
    rows: [first],
  } = await db.query("SELECT folder_id,created_by FROM artifacts WHERE id=$1", [f.first.artifactId]);
  assert.equal(first.folder_id, f.intoReports, "same-name folder joined");
  assert.equal(first.created_by, f.into.id);
  const folders = (
    await db.query("SELECT name FROM folders WHERE tenant_id=$1 ORDER BY name", [f.into.tenant])
  ).rows.map((row) => row.name);
  assert.deepEqual(folders, ["Отчёты", "Черновики"]);
  const moved = (
    await db.query(
      "SELECT object_key,object_version FROM revisions WHERE tenant_id=$1 AND artifact_id=ANY($2::uuid[])",
      [f.into.tenant, [f.first.artifactId, f.second.artifactId]],
    )
  ).rows;
  assert.equal(moved.length, 3);
  for (const row of moved) assert.ok(row.object_key.startsWith(`${f.into.tenant}/`), row.object_key);
  // The search text moved with its work (the shelf of artifact_search follows by its foreign key).
  const searchRows = (
    await db.query("SELECT tenant_id FROM artifact_search WHERE artifact_id=ANY($1::uuid[])", [
      [f.first.artifactId, f.second.artifactId],
    ])
  ).rows;
  assert.equal(searchRows.length, 2);
  for (const row of searchRows) assert.equal(row.tenant_id, f.into.tenant);
  // The originals under the source's prefix are gone.
  for (const row of before)
    await assert.rejects(
      s3.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: row.object_key,
          VersionId: row.object_version,
        }),
      ),
    );

  // Old links open the same work (the new version where the link moved).
  const opened = await openLink(f.first.url);
  assert.equal(opened.status, 200);
  assert.match(opened.body!, /Отчёт за квартал/);
  assert.equal((await openLink(f.second.url)).status, 200);

  // The owner's note moved with its link.
  const {
    rows: [note],
  } = await db.query("SELECT tenant_id,author_account_id FROM comments WHERE artifact_id=$1", [f.first.artifactId]);
  assert.equal(note.tenant_id, f.into.tenant);
  assert.equal(note.author_account_id, f.into.id);
  // So did the reaction, although the runtime role never updates reactions.
  const { rows: reactions } = await db.query(
    "SELECT tenant_id,author_account_id FROM comment_reactions WHERE artifact_id=$1",
    [f.first.artifactId],
  );
  assert.deepEqual(reactions, [{ tenant_id: f.into.tenant, author_account_id: f.into.id }]);

  // The source's agent token now saves to the target's shelf.
  const saved = await publish(f.fromToken, "После объединения");
  assert.equal(await tenantOf(saved.artifactId), f.into.tenant);
  // The connector's refresh token still refreshes, into the same shelf.
  const refreshed = await app.inject({
    method: "POST",
    url: "/oauth/token",
    remoteAddress: address(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: f.oauth.clientId,
      refresh_token: f.oauth.refresh,
    }).toString(),
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const viaConnector = await publish(refreshed.json().access_token, "Из Claude после объединения");
  assert.equal(await tenantOf(viaConnector.artifactId), f.into.tenant);

  // Identity, library, source closed.
  const {
    rows: [identity],
  } = await db.query("SELECT account_id FROM account_identities WHERE provider='yandex' AND subject=$1", [f.subject]);
  assert.equal(identity.account_id, f.into.id);
  const members = (
    await db.query("SELECT account_id,role,state FROM template_library_members WHERE library_id=$1", [f.library])
  ).rows;
  assert.deepEqual(Object.fromEntries(members.map((row) => [row.account_id, `${row.role}:${row.state}`])), {
    [f.from.id]: "admin:revoked",
    [f.into.id]: "admin:active",
  });
  const {
    rows: [source],
  } = await db.query("SELECT disabled,deletion_requested_at,email,display_name FROM accounts WHERE id=$1", [f.from.id]);
  assert.equal(source.disabled, true);
  // The emptied source is deleted, not only disabled: no address or name left.
  assert.ok(source.deletion_requested_at);
  assert.equal(source.email, null);
  assert.equal(source.display_name, null);
  assert.equal((await db.query("SELECT 1 FROM sessions WHERE account_id=$1", [f.from.id])).rowCount, 0);
  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { cookie: `polka_session=${f.session}` },
  });
  assert.equal(me.statusCode, 401);
  const {
    rows: [bytes],
  } = await db.query(
    "SELECT (SELECT used_bytes FROM tenants WHERE id=$1) AS source,(SELECT used_bytes FROM tenants WHERE id=$2) AS target",
    [f.from.tenant, f.into.tenant],
  );
  assert.equal(Number(bytes.source), 0);
  assert.ok(Number(bytes.target) > 0);

  // Journal and analytics.
  const {
    rows: [event],
  } = await db.query(
    "SELECT actor,details,reason,authority FROM moderation_events WHERE action='account.merged' AND account_id=$1",
    [f.from.id],
  );
  assert.equal(event.actor, "operator-script");
  assert.equal(event.authority, "обращение №1042");
  assert.equal(event.details.intoAccountId, f.into.id);
  assert.equal(event.reason, "одна полка");
  await flushAnalytics();
  assert.equal((await db.query("SELECT 1 FROM analytics_events WHERE actor=$1", [sourceKey])).rowCount, 0);
  const targetEvents = (
    await db.query("SELECT name FROM analytics_events WHERE actor=$1", [actorKey(f.into.id)])
  ).rows.map((row) => row.name);
  assert.equal(
    targetEvents.filter((name) => name === "signup_completed").length,
    1,
    "the source's sign-up is not counted twice",
  );
  assert.ok(targetEvents.filter((name) => name === "work_saved").length >= 3);
});

test("refuses a disabled side, the same account and blocked content", async () => {
  const f = await fixture();
  await assert.rejects(
    mergeAccounts({ from: f.from.id, into: f.from.id, actor: "operator-script", proof: "t" }),
    MergeRefusal,
  );
  await db.query(
    `INSERT INTO moderation_blocks(id,tenant_id,artifact_id,revision_id,sha256,category,isolated)
     SELECT $1,tenant_id,artifact_id,id,sha256,'fraud',false FROM revisions WHERE artifact_id=$2 LIMIT 1`,
    [randomUUID(), f.second.artifactId],
  );
  await assert.rejects(
    mergeAccounts({ from: f.from.id, into: f.into.id, actor: "operator-script", proof: "t" }),
    /заблокированное/,
  );
  assert.equal(await tenantOf(f.first.artifactId), f.from.tenant);
  const other = await fixture();
  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [other.into.id]);
  await assert.rejects(
    mergeAccounts({
      from: other.from.id,
      into: other.into.id,
      actor: "operator-script",
      proof: "t",
    }),
    /отключён/,
  );
  const refused: string[] = [];
  const error = console.error;
  console.error = (line: string) => refused.push(line);
  try {
    assert.equal(await runAccountMerge(["--from", other.from.id, "--into", other.into.id, "--proof", "t"]), 1);
  } finally {
    console.error = error;
  }
  assert.match(refused.join("\n"), /Отказ/);
});

test("an extension may refuse a merge and moves its own records inside it", async (t) => {
  t.after(() => useExtensions([]));
  const asked: AccountMerge[] = [];
  const moved: AccountMerge[] = [];
  let refuse: string | null = null;
  let fail = false;
  useExtensions([
    {
      name: "merge-test",
      policies: {
        accountMerge: async (merge, c) => {
          // The merge's own transaction: both accounts are locked by it.
          await c.query("SELECT 1 FROM accounts WHERE id=$1", [merge.from.accountId]);
          asked.push(merge);
          return refuse ? { allow: false, message: refuse } : { allow: true };
        },
      },
      accountMerged: async (merge, c) => {
        if (fail) throw new Error("extension rows did not move");
        // Sees the core's moves of this transaction.
        const {
          rows: [row],
        } = await c.query("SELECT count(*)::int AS n FROM artifacts WHERE tenant_id=$1", [merge.from.tenantId]);
        assert.equal(row.n, 0);
        moved.push(merge);
      },
    },
  ]);

  const f = await fixture();
  refuse = "Аккаунтом управляет каталог компании.";
  await assert.rejects(
    mergeAccounts({ from: f.from.id, into: f.into.id, actor: "operator-script", proof: "t", dryRun: true }),
    (error: unknown) => error instanceof MergeRefusal && /каталог компании/.test(error.message),
  );
  assert.deepEqual(asked.at(-1), {
    from: { accountId: f.from.id, tenantId: f.from.tenant },
    into: { accountId: f.into.id, tenantId: f.into.tenant },
    actor: "operator-script",
    dryRun: true,
  });
  assert.equal(moved.length, 0);

  // A failing move aborts the whole merge: the works stay on the source.
  refuse = null;
  fail = true;
  await assert.rejects(
    mergeAccounts({ from: f.from.id, into: f.into.id, actor: "operator-script", proof: "t" }),
    /extension rows did not move/,
  );
  assert.equal(await tenantOf(f.first.artifactId), f.from.tenant);

  fail = false;
  await mergeAccounts({ from: f.from.id, into: f.into.id, actor: "operator-script", proof: "t" });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].dryRun, false);
  assert.equal(await tenantOf(f.first.artifactId), f.into.tenant);
});

test("the web path refuses a shelf with more objects than the cap, before copying anything", async () => {
  const f = await fixture();
  const copied: string[] = [];
  const mover = {
    async copy(from: string, version: string, to: string) {
      copied.push(to);
      return version;
    },
    async remove() {},
  };
  await assert.rejects(
    mergeAccounts({ from: f.from.id, into: f.into.id, actor: "operator-script", proof: "t", maxObjects: 1, mover }),
    /слишком много файлов/,
  );
  assert.deepEqual(copied, []);
  assert.equal(await tenantOf(f.first.artifactId), f.from.tenant);
  assert.ok(WEB_MERGE_MAX_OBJECTS >= 1);
});

/** An agent session with a stored transcript, as agent-sessions.ts leaves it. */
async function agentSession(who: Owner, externalId: string, updatedAt: string) {
  const id = randomUUID();
  const gz = gzipSync(
    Buffer.from(`{"schema":"polka-session-transcript/1"}\n{"type":"prompt","text":"${externalId}"}\n`),
  );
  const key = `${who.tenant}/sessions/${id}/${sha256(gz)}.jsonl.gz`;
  const version = await putImmutable(key, gz);
  await db.query(
    `INSERT INTO agent_sessions(id,tenant_id,account_id,source,external_id,transcript_key,transcript_version,
       transcript_bytes,index_bytes,updated_at)
     VALUES($1,$2,$3,'claude-code',$4,$5,$6,$7,100,$8)`,
    [id, who.tenant, who.id, externalId, key, version, gz.length, updatedAt],
  );
  await db.query(
    `INSERT INTO agent_session_secrets(session_id,fingerprint,type,confidence,length,occurrences)
     VALUES($1,'0123456789ab','github-token','high',40,1)`,
    [id],
  );
  await db.query("UPDATE tenants SET session_used_bytes=session_used_bytes+$2 WHERE id=$1", [
    who.tenant,
    gz.length + 100,
  ]);
  return { id, key, version, bytes: gz.length + 100 };
}

const stored = (key: string, version: string) =>
  s3
    .send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: version }))
    .then(() => true)
    .catch(() => false);

test("agent sessions move with their transcripts, allowance and fingerprint key", async () => {
  const from = await owner("merge-sessions-from");
  const into = await owner("merge-sessions-into");
  const sourceKey = randomBytes(32);
  await db.query("UPDATE tenants SET session_quota_bytes=$2,session_fingerprint_key=$3 WHERE id=$1", [
    from.tenant,
    1024 * 1024,
    sourceKey,
  ]);
  const only = await agentSession(from, "only-on-source", "2026-10-01T10:00:00Z");
  // The same session sent to both shelves: the later upload stays.
  const newerOnSource = await agentSession(from, "twice-a", "2026-10-02T10:00:00Z");
  const olderOnTarget = await agentSession(into, "twice-a", "2026-10-01T10:00:00Z");
  const olderOnSource = await agentSession(from, "twice-b", "2026-10-01T10:00:00Z");
  const newerOnTarget = await agentSession(into, "twice-b", "2026-10-03T10:00:00Z");

  const dry = await mergeAccounts({ from: from.id, into: into.id, actor: "operator-script", dryRun: true });
  assert.equal(dry.counts.agentSessions, 3);
  assert.equal(dry.counts.agentSessionsTwice, 2);
  const report = await mergeAccounts({ from: from.id, into: into.id, actor: "operator-script", proof: "t" });
  assert.deepEqual(report.leftovers, []);

  const { rows } = await db.query(
    `SELECT id,tenant_id,account_id,transcript_key,transcript_version FROM agent_sessions WHERE tenant_id=ANY($1::uuid[])
      ORDER BY external_id`,
    [[from.tenant, into.tenant]],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    [only.id, newerOnSource.id, newerOnTarget.id],
  );
  for (const row of rows) {
    assert.equal(row.tenant_id, into.tenant);
    assert.equal(row.account_id, into.id);
    assert.ok(row.transcript_key.startsWith(`${into.tenant}/sessions/${row.id}/`));
    assert.ok(await stored(row.transcript_key, row.transcript_version));
  }
  // Facts of a moved session come along; the transcript opens for its new owner.
  assert.equal((await db.query("SELECT 1 FROM agent_session_secrets WHERE session_id=$1", [only.id])).rowCount, 1);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    remoteAddress: address(),
    headers: { origin },
    payload: { name: into.name, password },
  });
  const cookie = `polka_session=${login.cookies.find((c) => c.name === "polka_session")!.value}`;
  const page = await app.inject({
    method: "GET",
    url: `/api/sessions/${only.id}/transcript`,
    remoteAddress: address(),
    headers: { origin, cookie },
  });
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().events[0].text, "only-on-source");
  // Nothing of them is left under the source's prefix, nor the replaced copies.
  for (const gone of [only, newerOnSource, olderOnSource, olderOnTarget])
    assert.equal(await stored(gone.key, gone.version), false, gone.key);

  const {
    rows: [shelves],
  } = await db.query(
    `SELECT s.session_used_bytes AS source_used, s.session_fingerprint_key AS source_key,
            t.session_used_bytes AS target_used, t.session_quota_bytes AS target_quota, t.session_fingerprint_key AS target_key
       FROM tenants s, tenants t WHERE s.id=$1 AND t.id=$2`,
    [from.tenant, into.tenant],
  );
  assert.equal(Number(shelves.source_used), 0);
  assert.equal(shelves.source_key, null);
  assert.equal(Number(shelves.target_used), only.bytes + newerOnSource.bytes + newerOnTarget.bytes);
  assert.equal(Number(shelves.target_quota), 1024 * 1024);
  // The target had no key: it takes the source's, so old and new fingerprints match.
  assert.deepEqual(shelves.target_key, sourceKey);
});

test("a target with its own fingerprint key keeps it", async () => {
  const from = await owner("merge-keys-from");
  const into = await owner("merge-keys-into");
  const targetKey = randomBytes(32);
  await db.query("UPDATE tenants SET session_fingerprint_key=$2 WHERE id=$1", [from.tenant, randomBytes(32)]);
  await db.query("UPDATE tenants SET session_fingerprint_key=$2 WHERE id=$1", [into.tenant, targetKey]);
  await agentSession(from, "keyed", "2026-10-01T10:00:00Z");
  await mergeAccounts({ from: from.id, into: into.id, actor: "operator-script", proof: "t" });
  const {
    rows: [shelf],
  } = await db.query("SELECT session_fingerprint_key FROM tenants WHERE id=$1", [into.tenant]);
  assert.deepEqual(shelf.session_fingerprint_key, targetKey);
});

// A new table naming an account or a shelf must be handled by the merge or
// deliberately left: otherwise its rows stay with the source and its erasure
// takes them (agent sessions once did).
test("every column naming an account or a shelf is in the merge inventory", async () => {
  const { rows } = await db.query(
    `SELECT DISTINCT cl.relname || '.' || a.attname AS col
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid=con.conrelid
       JOIN pg_namespace n ON n.oid=cl.relnamespace AND n.nspname='public'
       JOIN pg_class ref ON ref.oid=con.confrelid AND ref.relname IN ('accounts','tenants')
       CROSS JOIN LATERAL unnest(con.conkey) AS k(attnum)
       JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.attnum
      WHERE con.contype='f'
     UNION
     SELECT cl.relname || '.' || a.attname
       FROM pg_attribute a
       JOIN pg_class cl ON cl.oid=a.attrelid AND cl.relkind IN ('r','p')
       JOIN pg_namespace n ON n.oid=cl.relnamespace AND n.nspname='public'
      WHERE a.attnum > 0 AND NOT a.attisdropped
        AND (a.attname IN ('tenant_id','account_id') OR a.attname LIKE '%\\_account\\_id')
     ORDER BY 1`,
  );
  const columns = rows.map((row) => row.col as string);
  assert.deepEqual(
    columns.filter((column) => !(column in MERGE_INVENTORY)),
    [],
    "add these to MERGE_INVENTORY in apps/server/account-merge.ts: move them in mergeAccounts or say why they stay",
  );
  assert.deepEqual(
    Object.keys(MERGE_INVENTORY).filter((column) => !columns.includes(column)),
    [],
    "no longer in the schema: remove from MERGE_INVENTORY",
  );
});

// Hosted installations grant the application role no TEMPORARY privilege
// (deploy/migrations grants); a temporary table there fails the whole merge.
test("server code creates no temporary tables", async () => {
  const dir = new URL("../apps/server/", import.meta.url);
  const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith(".ts"));
  for (const file of files) {
    const source = await readFile(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /CREATE\s+TEMP(ORARY)?\s+TABLE/i, file);
  }
});
