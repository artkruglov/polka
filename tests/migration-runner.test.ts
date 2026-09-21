import assert from "node:assert/strict";
import test from "node:test";
import { closeMigrationClient, runMigrations } from "../scripts/migration-runner.ts";

function fixture(existing: number[] = [], failure?: string) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = { async query(sql: string, values?: unknown[]) {
    calls.push({ sql, values });
    if (sql === failure) throw new Error("fixture migration failure");
    return { rowCount: sql.startsWith("SELECT 1 FROM") && existing.includes(Number(values?.[0])) ? 1 : 0, rows: [] };
  }};
  return { calls, client: client as Parameters<typeof runMigrations>[0] };
}
const migrations = [{version: 1, file: "001.sql"}, {version: 2, file: "002.sql"}];

test("holds the transaction advisory lock before applying only missing migrations", async () => {
  const {client,calls}=fixture([1]);const reads:string[]=[];
  await runMigrations(client,migrations,async f=>{reads.push(f);return "SQL "+f;});
  assert.deepEqual(reads,["002.sql"]);
  assert.equal(calls[0].sql,"BEGIN");
  assert.equal(calls[1].sql,"SELECT pg_advisory_xact_lock(4388001)");
  assert.deepEqual(calls.filter(c=>c.sql.startsWith("INSERT")).map(c=>c.values),[[2]]);
  assert.equal(calls.at(-1)?.sql,"COMMIT");
});
test("a failed migration rolls back and never records it or starts a later migration", async () => {
  const {client,calls}=fixture([],"SQL 001.sql");
  await assert.rejects(runMigrations(client,migrations,async f=>"SQL "+f),/fixture/);
  assert.equal(calls.at(-1)?.sql,"ROLLBACK");
  assert.equal(calls.some(c=>c.sql.startsWith("INSERT")||c.sql==="COMMIT"||c.sql==="SQL 002.sql"),false);
});
test("missing source file rolls back without committing the version", async () => {
  const {client,calls}=fixture();
  await assert.rejects(runMigrations(client,migrations,async()=>{throw new Error("missing source");}),/missing source/);
  assert.equal(calls.at(-1)?.sql,"ROLLBACK");
  assert.equal(calls.some(c=>c.sql.startsWith("INSERT")||c.sql==="COMMIT"),false);
});

test("database close handles rejection and a hung connection within its deadline", async () => {
  assert.equal(await closeMigrationClient({end: async()=>{}}),true);
  assert.equal(await closeMigrationClient({end: async()=>{throw new Error("private provider diagnostic");}}),false);
  assert.equal(await closeMigrationClient({end: ()=>new Promise<void>(()=>{})},10),false);
});
