import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createAccount } from "../apps/server/auth.ts";
import { db } from "../apps/server/db.ts";
import { sha256, s3 } from "../apps/server/storage.ts";
import {
  authenticateServiceToken,
  MCP_AUDIENCE,
} from "../apps/server/service-auth.ts";
import {
  captureFromAgent,
  statusForAgent,
} from "../apps/server/agent-capture.ts";
import { prepareCapture } from "../scripts/prepare-capture.ts";
import { exportRevision } from "../apps/server/artifacts.ts";

after(async () => {
  await db.end();
  s3.destroy();
});
test("agent capture is exact, resumable, connection-bound and denied after revoke", async () => {
  const owner = await createAccount(
    "capture-" + randomBytes(5).toString("hex"),
    randomBytes(24).toString("hex"),
  );
  async function connection() {
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    await db.query(
      `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at) VALUES($1,$2,$3,$4,'test',ARRAY['context','capture','revise'],$5,now()+interval '1 day')`,
      [id, owner.tenant, owner.id, sha256(token), MCP_AUDIENCE],
    );
    return authenticateServiceToken(token, MCP_AUDIENCE, "capture");
  }
  const actor = await connection(),
    other = await connection();
  const payload = {
    ...(await prepareCapture(
      "tests/fixtures/bundle-corpus/team-report",
      "index.html",
      [
        "index.html",
        "assets/report.css",
        "assets/report.js",
        "assets/mark.svg",
      ],
    )),
    key: randomUUID(),
    title: "Agent original",
  };
  const receipt = await captureFromAgent(actor, payload, "capture");
  assert.deepEqual(await captureFromAgent(actor, payload, "capture"), receipt);
  assert.equal(
    (await statusForAgent(actor, { uploadId: receipt.uploadId })).state,
    "saved",
  );
  assert.deepEqual(
    (await statusForAgent(actor, { key: payload.key })).receipt,
    receipt,
  );
  await assert.rejects(
    statusForAgent(other, { key: payload.key }),
    (e: any) => e.status === 404,
  );
  await assert.rejects(
    statusForAgent(other, { uploadId: receipt.uploadId }),
    (e: any) => e.status === 404,
  );
  const audit = (
    await db.query(
      "SELECT actor_type,connection_id FROM audit_outbox WHERE tenant_id=$1 AND target_id=$2",
      [owner.tenant, receipt.revisionId],
    )
  ).rows;
  assert(audit.length > 0);
  assert(
    audit.every(
      (x) => x.actor_type === "agent" && x.connection_id === actor.connectionId,
    ),
  );
  await assert.rejects(
    captureFromAgent(other, payload, "capture"),
    (e: any) => e.status === 409,
  );
  const exported = await exportRevision(
    { id: owner.id, tenant: owner.tenant },
    receipt.revisionId,
  );
  for (const f of exported.files)
    assert.equal(f.data, payload.files.find((x) => x.path === f.path)!.data);
  const corrupt = {
    ...payload,
    key: randomUUID(),
    files: payload.files.map((f, i) => (i ? f : { ...f, data: "!bad" })),
  };
  await assert.rejects(captureFromAgent(actor, corrupt, "capture"));
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM uploads WHERE tenant_id=$1 AND idempotency_key=$2",
        [owner.tenant, corrupt.key],
      )
    ).rowCount,
    0,
  );
  const revised = await captureFromAgent(
    actor,
    {
      ...payload,
      key: randomUUID(),
      artifactId: receipt.artifactId,
      baseRevisionId: receipt.revisionId,
      title: "Revision",
    },
    "revise",
  );
  assert.equal(revised.number, 2);
  await db.query(
    "UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE id=$1",
    [actor.connectionId],
  );
  await assert.rejects(
    captureFromAgent(actor, payload, "capture"),
    (e: any) => e.status === 401,
  );
});
