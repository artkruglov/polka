import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

const runId = process.env.EMAIL_PURGE_TEST_RUN_ID ?? "";
if (!/^[a-z0-9]{10,24}$/.test(runId)) throw new Error("Isolated mail race run id required");
const database = `polka_r17_test_${runId}`;
function client(value: string | undefined, role: string) {
  const url = new URL(value ?? "http://invalid");
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== `/${database}` || url.username !== role || url.search || url.hash)
    throw new Error("Isolated mail race identity required");
  return { url, role, connection: new pg.Client({ connectionString: url.toString(),
    connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 }) };
}
const app = client(process.env.DATABASE_URL, `polka_runtime_${runId}`);
const purge = client(process.env.PURGE_TEST_WORKER_DATABASE_URL, `polka_purge_${runId}`);
const admin = client(process.env.PURGE_TEST_OWNER_DATABASE_URL, `polka_schema_${runId}`);
const clients = [app, purge, admin];
for (const c of clients) {
  assert.equal(c.url.hostname, app.url.hostname);
  assert.equal(c.url.port, app.url.port);
}
const roots: string[] = [];
let deliver: typeof import('../apps/server/email-auth.ts').deliverLocalEmailChallenge;
let appPid: number, purgePid: number;

async function tx<T>(c: pg.Client, fn: (c: pg.Client) => Promise<T>) {
  await c.query('BEGIN');
  try { const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (error) { await c.query('ROLLBACK'); throw error; }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
before(async () => {
  await Promise.all(clients.map(async (c) => {
    await c.connection.connect();
    const result = await c.connection.query(`SELECT current_user,session_user,current_database(),
      shobj_description(oid,'pg_database') AS sentinel FROM pg_database WHERE datname=current_database()`);
    assert.deepEqual(result.rows[0], { current_user: c.role, session_user: c.role,
      current_database: database, sentinel: `polka-r17-test:${runId}` });
  }));
  appPid = (await app.connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  purgePid = (await purge.connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  deliver = (await import('../apps/server/email-auth.ts')).deliverLocalEmailChallenge;
});
after(async () => {
  await Promise.all(clients.map(async ({connection}) => {
    const timer = setTimeout(() => (connection as any).connection?.stream?.destroy(), 1000);
    try { await connection.end(); } finally { clearTimeout(timer); }
  }));
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function seed() {
  const ids = { account: randomUUID(), tenant: randomUUID(), deletion: randomUUID(),
    challenge: randomUUID(), attempt: randomUUID(), ledger: randomUUID() };
  const email = `race-${ids.account}@example.test`;
  const root = await mkdtemp(join(tmpdir(), 'polka-email-race-')); roots.push(root);
  await tx(admin.connection, async (c) => {
    await c.query('INSERT INTO accounts(id,name,password_hash,email) VALUES($1,$2,$3,$4)',
      [ids.account, `race-${ids.account}`, `${'1'.repeat(32)}:${'2'.repeat(128)}`, email]);
    await c.query('INSERT INTO tenants(id,owner_id) VALUES($1,$2)', [ids.tenant, ids.account]);
    await c.query(`INSERT INTO account_deletions(id,account_id,tenant_id,state,status_capability_hash,
      plan_expires_at,artifact_count,revision_count,source_bytes,derivative_bytes,policy_version,
      purge_max_hours,backup_retention_max_days)
      VALUES($1,$2,$3,'planned',$4,now()+interval '10 minutes',0,0,0,0,'race-v1',24,1)`,
      [ids.deletion, ids.account, ids.tenant, randomUUID().replaceAll('-','').repeat(2)]);
    await c.query(`INSERT INTO login_challenges(id,email,code_hash,browser_hash,delivery,expires_at)
      VALUES($1,$2,$3,$4,'local',now()+interval '10 minutes')`,
      [ids.challenge, email, '5'.repeat(64), '6'.repeat(64)]);
  });
  return { ...ids, email, file: join(root, `${ids.challenge}.json`) };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
async function queue(f: Fixture) {
  await tx(admin.connection, async (c) => {
    await c.query('UPDATE accounts SET disabled=true,deletion_requested_at=clock_timestamp() WHERE id=$1', [f.account]);
    await c.query(`UPDATE account_deletions SET state='access_revoked_pending_purge',
      requested_at=clock_timestamp(),revoked_at=clock_timestamp(),confirmation_session_hash=repeat('4',64),
      working_data_policy_deadline=clock_timestamp()+interval '24 hours',
      backup_retention_policy_deadline=clock_timestamp()+interval '1 day' WHERE id=$1`, [f.deletion]);
  });
  const job = (await purge.connection.query('SELECT * FROM claim_account_purge_job($1,$2)', [f.attempt, f.ledger])).rows[0];
  assert.equal(job.deletion_id, f.deletion);
  await purge.connection.query('SELECT acknowledge_account_purge_revoke($1,$2,$3,$4,$5)',
    [f.deletion, f.attempt, `erasure/v1/${f.ledger}/${f.deletion}/revoke.json`, '7'.repeat(64), 'test-version']);
  await purge.connection.query('SELECT mark_account_purge_source_empty($1,$2,clock_timestamp())', [f.deletion, f.attempt]);
}
async function clearMail(f: Fixture) {
  return tx(purge.connection, async (c) => {
    const mail = (await c.query('SELECT * FROM lock_account_purge_mail($1,$2)', [f.deletion, f.attempt])).rows[0];
    assert.deepEqual(mail.challenges.map((item: { id: string }) => item.id), [f.challenge]);
    try { await unlink(f.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await c.query('SELECT complete_account_purge_mail($1,$2,clock_timestamp(),$3)', [f.deletion, f.attempt, [f.challenge]]);
  });
}
async function assertGone(f: Fixture) {
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  assert.equal((await admin.connection.query('SELECT id FROM login_challenges WHERE id=$1', [f.challenge])).rowCount, 0);
}

test('purge waits for the actual local writer transaction before removing its file', { timeout: 15000 }, async () => {
  const f = await seed();
  const entered = deferred(), release = deferred();
  const writing = deliver({id:f.challenge,email:f.email,code:'123456'}, {
    runTransaction: (operation) => tx(app.connection, operation),
    write: async (path, body) => {
      assert.equal(path, `.local/mail/${f.challenge}.json`);
      entered.resolve(); await release.promise;
      await writeFile(f.file, body, {flag:'wx',mode:0o600});
    },
  });
  void writing.catch(() => {});
  let clearing: Promise<void> | undefined;
  try {
    await Promise.race([entered.promise, writing.then(() => { throw new Error('Writer did not reach barrier'); })]);
    await queue(f);
    clearing = clearMail(f); void clearing.catch(() => {});
    const deadline = Date.now()+2500;
    let waiting = false;
    while (Date.now()<deadline) {
      const result = await admin.connection.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
        WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting,
        $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked`, [purgePid,appPid]);
      if (result.rows[0].waiting && result.rows[0].blocked) { waiting=true; break; }
      await new Promise((resolve) => setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'Purge must block on the paused writer session');
    release.resolve(); assert.equal(await writing,true); await clearing;
    await assertGone(f);
  } finally { release.resolve(); await Promise.allSettled([writing,...(clearing?[clearing]:[])]); }
});

test('a late local delivery cannot recreate a challenge removed by purge', { timeout:15000 }, async () => {
  const f = await seed(); await queue(f); await clearMail(f);
  let writes=0;
  const result = await deliver({id:f.challenge,email:f.email,code:'123456'}, {
    runTransaction: (operation) => tx(app.connection,operation),
    write: async (_path,body) => { writes++; await writeFile(f.file,body,{flag:'wx'}); },
  });
  assert.equal(result,false); assert.equal(writes,0); await assertGone(f);
});
