// The operator's erasure request (apps/server/account-erase.ts): a dry run
// counts, a request closes the account at once and queues the purge worker
// (whose own tests are account-purge*.test.ts), a rerun sees the request.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createAccount } from "../apps/server/auth.ts";
import { beginUpload, finalizeUpload, uploadBytes } from "../apps/server/artifacts.ts";
import { requestAccountErasure, ErasureRefusal } from "../apps/server/account-erase.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { runAccountErase } from "../scripts/account-erase.ts";

const policy = { policyVersion: "test-2026-09-28", purgeMaxHours: 720, backupRetentionMaxDays: 30 };

after(async () => {
  await db.end();
  s3.destroy();
});

async function shelf() {
  const owner = await createAccount(`erase-${randomBytes(5).toString("hex")}`, randomBytes(24).toString("hex"));
  const bytes = Buffer.from("Текст работы\n");
  const begun = await beginUpload(owner, {
    key: randomUUID(),
    title: "Заметка",
    filename: "note.txt",
    mime: "text/plain",
    size: bytes.length,
    sha256: sha256(bytes),
  });
  await uploadBytes(owner, begun.uploadId, bytes);
  const saved: any = await finalizeUpload(owner, begun.uploadId);
  await db.query(
    `INSERT INTO shares(id,tenant_id,artifact_id,revision_id,token_hash,expires_at,created_by)
     VALUES($1,$2,$3,$4,$5,now()+interval '7 days',$6)`,
    [randomUUID(), owner.tenant, saved.artifactId, saved.revisionId, sha256(randomBytes(32)), owner.id],
  );
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'erase test',ARRAY['capture'],$5,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(randomBytes(32)), MCP_AUDIENCE],
  );
  await db.query("INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [
    sha256(randomBytes(32)),
    owner.id,
  ]);
  return owner;
}

test("a dry run counts and changes nothing; a request needs its ground", async () => {
  const owner = await shelf();
  const dry = await requestAccountErasure({ account: owner.name, dryRun: true, policy });
  assert.equal(dry.state, "would_request");
  assert.equal(dry.counts.works, 1);
  assert.equal(dry.counts.agents, 1);
  const { rows: [account] } = await db.query("SELECT disabled,deletion_requested_at FROM accounts WHERE id=$1", [owner.id]);
  assert.deepEqual({ ...account }, { disabled: false, deletion_requested_at: null });
  await assert.rejects(requestAccountErasure({ account: owner.name, dryRun: false, policy }), ErasureRefusal);
  await assert.rejects(requestAccountErasure({ account: "nobody-here", dryRun: true, policy }), /не найден/);
});

test("a request closes the account at once and queues the purge", async () => {
  const owner = await shelf();
  const report = await requestAccountErasure({
    account: owner.id,
    dryRun: false,
    proof: "обращение №1",
    reason: "просьба владельца",
    policy,
  });
  assert.equal(report.state, "requested");
  const { rows: [state] } = await db.query(
    `SELECT a.disabled, a.deletion_requested_at IS NOT NULL AS deleting,
            d.state, d.purge_max_hours, d.policy_version,
            (SELECT count(*)::int FROM agent_connections WHERE tenant_id=$2 AND revoked_at IS NULL) AS live_agents,
            (SELECT count(*)::int FROM shares WHERE tenant_id=$2 AND NOT revoked) AS live_links,
            (SELECT count(*)::int FROM sessions WHERE account_id=$1) AS sessions,
            (SELECT count(*)::int FROM account_purge_jobs WHERE account_id=$1) AS jobs,
            (SELECT authority FROM moderation_events WHERE account_id=$1 AND action='account.erasure_requested') AS proof
       FROM accounts a JOIN account_deletions d ON d.account_id=a.id WHERE a.id=$1`,
    [owner.id, owner.tenant],
  );
  assert.deepEqual(
    { ...state },
    {
      disabled: true,
      deleting: true,
      state: "access_revoked_pending_purge",
      purge_max_hours: 720,
      policy_version: "test-2026-09-28",
      live_agents: 0,
      live_links: 0,
      sessions: 0,
      jobs: 1,
      proof: "обращение №1",
    },
  );
  // Rerun: the request is there; nothing is requested twice.
  const again = await requestAccountErasure({ account: owner.id, dryRun: false, proof: "обращение №1", policy });
  assert.equal(again.state, "access_revoked_pending_purge");
});

test("the CLI refuses without the policy and prints no content", async () => {
  const owner = await shelf();
  const lines: string[] = [];
  const log = console.log, error = console.error;
  console.log = (line: string) => lines.push(line);
  console.error = (line: string) => lines.push(line);
  try {
    assert.equal(await runAccountErase(["--account", owner.name, "--dry-run"], {}), 1);
    assert.match(lines.join("\n"), /ACCOUNT_PURGE_MAX_HOURS/);
    lines.length = 0;
    const env = { ACCOUNT_DELETION_POLICY_VERSION: "v", ACCOUNT_PURGE_MAX_HOURS: "720", BACKUP_RETENTION_MAX_DAYS: "30" };
    assert.equal(await runAccountErase(["--account", owner.name, "--dry-run"], env), 0);
    assert.match(lines.join("\n"), /Пробный прогон.*работ 1/s);
    assert.doesNotMatch(lines.join("\n"), /Текст работы/);
  } finally {
    console.log = log;
    console.error = error;
  }
});
