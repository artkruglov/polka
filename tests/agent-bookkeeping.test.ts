import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { createAccount } from "../apps/server/auth.ts";
import { db } from "../apps/server/db.ts";
import { memoisedToolSchema } from "../apps/server/mcp-server.ts";
import { authenticateServiceToken, MCP_AUDIENCE, recheckServiceActor } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

// What an agent's call costs besides its work (service-auth.ts, mcp-server.ts):
// last_seen_at at most once a minute and tool schemas converted once; access
// checks themselves are never cached.
after(async () => {
  await db.end();
  s3.destroy();
});

async function token() {
  const owner = await createAccount(`bookkeeping-${randomBytes(4).toString("hex")}`, randomBytes(24).toString("hex"));
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'bookkeeping',$5,$6,now()+interval '1 day')`,
    [id, owner.tenant, owner.id, sha256(secret), ["context", "read"], MCP_AUDIENCE],
  );
  return { id, secret };
}

const lastSeen = async (id: string) =>
  (await db.query("SELECT last_seen_at FROM agent_connections WHERE id=$1", [id])).rows[0].last_seen_at as Date | null;

test("last_seen_at is written at most once a minute per connection", async () => {
  const { id, secret } = await token();
  await authenticateServiceToken(secret, MCP_AUDIENCE, undefined, "http");
  assert.ok(await lastSeen(id), "the first call is recorded");
  await db.query(
    "UPDATE agent_connections SET created_at=now()-interval '2 days',last_seen_at=now()-interval '1 day' WHERE id=$1",
    [id],
  );
  const stale = await lastSeen(id);
  await authenticateServiceToken(secret, MCP_AUDIENCE, undefined, "http");
  await authenticateServiceToken(secret, MCP_AUDIENCE, undefined, "http");
  assert.deepEqual(await lastSeen(id), stale, "calls within the minute write nothing");
});

test("a recheck always reads the connection: no auth decision outlives its request", async () => {
  // An actor checked before its owner's account deletion (or a revoke) must be
  // refused by the next recheck, however soon it comes (the early bearer check
  // of admission.ts and the throttled bookkeeping must not cache it).
  const { id, secret } = await token();
  const actor = await authenticateServiceToken(secret, MCP_AUDIENCE, undefined, "http");
  const query = mock.method(db, "query");
  try {
    assert.equal((await recheckServiceActor(actor, "read")).connectionId, id);
    assert.equal(query.mock.callCount(), 1);
  } finally {
    mock.restoreAll();
  }
  const {
    rows: [connection],
  } = await db.query("SELECT account_id FROM agent_connections WHERE id=$1", [id]);
  await db.query("UPDATE accounts SET disabled=true,deletion_requested_at=now() WHERE id=$1", [connection.account_id]);
  await assert.rejects(recheckServiceActor(actor, "read"), { status: 401 });
  await assert.rejects(authenticateServiceToken(secret, MCP_AUDIENCE, undefined, "http"), { status: 401 });
});

test("a tool's schema is converted to JSON Schema once and validates as before", () => {
  const schema = z.object({ artifactId: z.string().uuid(), limit: z.number().int().max(100).optional() }).strict();
  const first = memoisedToolSchema("bookkeeping_tool", schema) as typeof schema;
  assert.equal(memoisedToolSchema("bookkeeping_tool", z.object({})), first, "kept by tool name");
  const options = { target: "draft-2020-12" };
  const json = first["~standard"].jsonSchema.input(options);
  assert.deepEqual(json, schema["~standard"].jsonSchema.input(options));
  assert.equal(first["~standard"].jsonSchema.input(options), json, "converted once");
  assert.equal(first.safeParse({ artifactId: randomUUID() }).success, true);
  assert.equal(first.safeParse({ artifactId: "x", extra: 1 }).success, false);
  const valid = first["~standard"].validate({ artifactId: randomUUID(), limit: 5 });
  assert.ok(!(valid instanceof Promise) && !valid.issues);
});
