// Onboarding decisions of 15.10.2026 (docs/specs/ONBOARDING_V2.md): «Скрыть»
// is account state (POST /api/account/onboarding/hide|unhide, /api/session
// onboardingHiddenAt), and each work says who saved its latest version
// (Artifact.savedBy: the owner or an agent connection by name).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import {
  SAVED_BY_SQL,
  beginUpload,
  finalizeUpload,
  getArtifacts,
  uploadBytes,
  type Actor,
} from "../apps/server/artifacts.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";

before(async () => {
  owner = await createAccount(`onboarding-${randomBytes(5).toString("hex")}`, password);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: owner.name, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = `polka_session=${login.cookies[0]!.value}`;
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

const session = async () => {
  const response = await app.inject({ method: "GET", url: "/api/session", headers: { cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().account as { id: string; onboardingHiddenAt: string | null };
};

test("«Скрыть» is stored on the account, from the app's own origin only", async () => {
  assert.equal((await session()).onboardingHiddenAt, null);
  // Without a session: nothing to hide.
  const guest = await app.inject({ method: "POST", url: "/api/account/onboarding/hide", headers: { origin } });
  assert.equal(guest.statusCode, 401);
  // A cross-site form or fetch: refused by the Origin check, nothing stored.
  for (const headers of [{ cookie }, { cookie, origin: "https://evil.example" }]) {
    const forged = await app.inject({ method: "POST", url: "/api/account/onboarding/hide", headers });
    assert.equal(forged.statusCode, 403, forged.body);
  }
  assert.equal((await session()).onboardingHiddenAt, null);

  const hidden = await app.inject({
    method: "POST",
    url: "/api/account/onboarding/hide",
    headers: { origin, cookie },
    payload: {},
  });
  assert.equal(hidden.statusCode, 200, hidden.body);
  const at = hidden.json().onboardingHiddenAt as string;
  assert.ok(Number.isFinite(Date.parse(at)));
  assert.equal((await session()).onboardingHiddenAt, at);
  // Again: the first moment stays.
  const again = await app.inject({ method: "POST", url: "/api/account/onboarding/hide", headers: { origin, cookie } });
  assert.equal(again.json().onboardingHiddenAt, at);

  const shown = await app.inject({
    method: "POST",
    url: "/api/account/onboarding/unhide",
    headers: { origin, cookie },
    payload: {},
  });
  assert.equal(shown.statusCode, 200, shown.body);
  assert.deepEqual(shown.json(), { onboardingHiddenAt: null });
  assert.equal((await session()).onboardingHiddenAt, null);
});

// An agent connection saves as the owner with its connection id (Actor), as
// the MCP tools and the publish API do.
async function agent(name: string): Promise<Actor> {
  const connectionId = randomUUID();
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,$5,ARRAY['context','capture','revise'],$6,now()+interval '1 day')`,
    [connectionId, owner.tenant, owner.id, sha256(randomBytes(32).toString("base64url")), name, MCP_AUDIENCE],
  );
  return { id: owner.id, tenant: owner.tenant, connectionId };
}

async function save(actor: Actor, title: string, base?: { artifactId: string; revisionId: string }) {
  const bytes = Buffer.from(`${title}\n${randomUUID()}\n`);
  const started = await beginUpload(actor, {
    key: randomUUID(),
    title,
    filename: "note.txt",
    mime: "text/plain",
    size: bytes.length,
    sha256: sha256(bytes),
    ...(base && { artifactId: base.artifactId, baseRevisionId: base.revisionId }),
  });
  await uploadBytes(actor, started.uploadId, bytes);
  return (await finalizeUpload(actor, started.uploadId)) as { artifactId: string; revisionId: string };
}

test("each work says who saved its latest version: the owner or the agent by name", async () => {
  const self = { id: owner.id, tenant: owner.tenant };
  const codex = await agent("Codex");
  const byOwner = await save(self, "Saved in the browser");
  const byAgent = await save(codex, "Saved by Codex");
  // The owner's work, revised by the agent: the latest version counts.
  const revised = await save(codex, "Revised by Codex", await save(self, "Started by the owner"));
  const [mine, theirs, latest] = await getArtifacts(self, [byOwner.artifactId, byAgent.artifactId, revised.artifactId]);
  assert.deepEqual(mine!.savedBy, { type: "owner" });
  assert.deepEqual(theirs!.savedBy, { type: "agent", name: "Codex" });
  assert.deepEqual(latest!.savedBy, { type: "agent", name: "Codex" });

  // The shelf list carries it too.
  const list = await app.inject({ method: "GET", url: "/api/artifacts", headers: { cookie } });
  assert.equal(list.statusCode, 200, list.body);
  const items = new Map((list.json().items as any[]).map((item) => [item.id, item.savedBy]));
  assert.deepEqual(items.get(byOwner.artifactId), { type: "owner" });
  assert.deepEqual(items.get(byAgent.artifactId), { type: "agent", name: "Codex" });

  // A version whose audit row is gone says nothing rather than guessing.
  await db.query("DELETE FROM audit_outbox WHERE target_id=$1", [byOwner.revisionId]);
  const [unknown] = await getArtifacts(self, [byOwner.artifactId]);
  assert.equal(unknown!.savedBy, undefined);
});

test("who saved a version is read with the partial index, one statement per page", async () => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // A handful of rows would be read by a scan; this asks whether the index fits.
    await client.query("SET LOCAL enable_seqscan=off");
    const { rows } = await client.query(`EXPLAIN ${SAVED_BY_SQL}`, [owner.tenant, [randomUUID(), randomUUID()]]);
    assert.match(rows.map((row) => row["QUERY PLAN"]).join("\n"), /audit_outbox_saved/);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
