// POST /api/v1/publish with a React component where the interactive viewer is
// on (docs/PUBLISH_API.md): the component compiles in the same call, and a new
// version keeps the work's link. This is how an agent with a shell publishes
// a component from disk instead of pasting it into a tool argument.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { publishResponseSchema } from "../apps/server/publish-api.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const app = await createApp();
let owner: Awaited<ReturnType<typeof createAccount>>;
let secret = "";

const address = () =>
  `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

const counter = (label: string) => `import React, { useState } from "react";
export default function App() {
  const [count, setCount] = useState(0);
  return <div style={{ height: "100%" }}><button onClick={() => setCount(count + 1)}>${label} {count}</button></div>;
}
`;

function publish(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress: address(),
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
}

before(async () => {
  owner = await createAccount(
    `publish-component-${randomBytes(5).toString("hex")}`,
    randomBytes(24).toString("hex"),
  );
  secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'Claude Code',$5,$6,now()+interval '1 day')`,
    [
      randomUUID(),
      owner.tenant,
      owner.id,
      sha256(secret),
      ["context", "capture", "revise", "share"],
      MCP_AUDIENCE,
    ],
  );
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("a component from disk compiles, and its new version keeps the link", async () => {
  assert.ok(config.HTML_LIVE_ENABLED, "run with the live suite");
  const first = await publish({
    key: randomUUID(),
    title: "Прототип",
    component: counter("Версия 1"),
  });
  assert.equal(first.statusCode, 200, first.body);
  const v1 = publishResponseSchema.parse(first.json());
  assert.equal(v1.state, "shared");
  assert.equal(v1.interactiveReady, true, v1.interactiveUnavailableReason ?? "");
  assert.equal(v1.scriptsRunForRecipients, true);

  const second = await publish({
    key: randomUUID(),
    title: "Прототип",
    component: counter("Версия 2"),
    artifactId: v1.artifactId,
    baseRevisionId: v1.revisionId,
  });
  assert.equal(second.statusCode, 200, second.body);
  const v2 = publishResponseSchema.parse(second.json());
  assert.equal(v2.artifactId, v1.artifactId);
  assert.notEqual(v2.revisionId, v1.revisionId);
  assert.equal(v2.url, v1.url);
  assert.equal(v2.linkMoved, true);
  assert.equal(v2.interactiveReady, true, v2.interactiveUnavailableReason ?? "");
  assert.equal(v2.scriptsRunForRecipients, true);
  const {
    rows: [share],
  } = await db.query(
    `SELECT revision_id, derivative_id FROM shares
     WHERE artifact_id=$1 AND NOT revoked`,
    [v1.artifactId],
  );
  assert.equal(share.revision_id, v2.revisionId);
  assert.ok(share.derivative_id, "the link opens the interactive version");
});
