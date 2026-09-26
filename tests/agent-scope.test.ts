// An agent limited to a folder (docs/specs/EXTENSIONS.md, policies.
// agentScope): it saves into the folder, sees and changes only works there,
// and does not manage folders. The same shelf's other agent is unaffected.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { PolkaExtension } from "../packages/extension-api/index.ts";
import { useExtensions } from "../apps/server/extensions.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

// connection id → the folders it is limited to
const scopes = new Map<string, string[]>();
const scoped: PolkaExtension = {
  name: "scoped",
  policies: {
    async agentScope(connection) {
      const folderIds = scopes.get(connection.connectionId);
      return folderIds ? { folderIds } : null;
    },
  },
};
useExtensions([scoped]);
const { createApp } = await import("../apps/server/app.ts");
const app = await createApp();
const mcpHost = new URL(MCP_AUDIENCE).host;
const address = () => `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
let owner: Awaited<ReturnType<typeof createAccount>>;
let reports = "";
let other = "";
const limited = { id: randomUUID(), secret: randomBytes(32).toString("base64url") };
const whole = { id: randomUUID(), secret: randomBytes(32).toString("base64url") };

async function mcp(secret: string, name: string, args: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: address(),
    headers: {
      host: mcpHost,
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  const text = String(response.headers["content-type"]).startsWith("text/event-stream")
    ? response.body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("")
    : response.body;
  const result = JSON.parse(text).result;
  const raw = result.content[0].text as string;
  let value: any = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // A refusal is plain text.
  }
  return { error: !!result.isError, value };
}

const page = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Текст отчёта.</p></body></html>`;

before(async () => {
  owner = await createAccount(`scope-${randomBytes(5).toString("hex")}`, randomBytes(24).toString("hex"));
  reports = randomUUID();
  other = randomUUID();
  await db.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$3,'Отчёты'),($2,$3,'Личное')", [reports, other, owner.tenant]);
  for (const connection of [limited, whole])
    await db.query(
      `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
       VALUES($1,$2,$3,$4,'agent',ARRAY['context','read','capture','manage','source:read'],$5,now()+interval '1 day')`,
      [connection.id, owner.tenant, owner.id, sha256(connection.secret), MCP_AUDIENCE],
    );
  scopes.set(limited.id, [reports]);
  for (const connection of [limited, whole])
    await app.inject({
      method: "POST",
      url: "/mcp",
      remoteAddress: address(),
      headers: {
        host: mcpHost,
        authorization: `Bearer ${connection.secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      },
    });
});

after(async () => {
  useExtensions([]);
  await app.close();
  await db.end();
  s3.destroy();
});

test("an agent limited to a folder saves there, sees only it and does not manage folders", async () => {
  // The unlimited agent keeps a work in «Личное».
  const personal = await mcp(whole.secret, "polka_publish", { key: randomUUID(), title: "Личное", html: page("Личное"), folderId: other });
  assert.equal(personal.error, false, JSON.stringify(personal.value));
  // The limited agent saves without a folder: the work goes to «Отчёты».
  const saved = await mcp(limited.secret, "polka_publish", { key: randomUUID(), title: "Отчёт", html: page("Отчёт") });
  assert.equal(saved.error, false, JSON.stringify(saved.value));
  const { rows: [work] } = await db.query("SELECT folder_id FROM artifacts WHERE id=$1", [saved.value.artifactId]);
  assert.equal(work.folder_id, reports);
  // Into another folder: refused.
  const elsewhere = await mcp(limited.secret, "polka_publish", { key: randomUUID(), title: "Туда", html: page("Туда"), folderId: other });
  assert.equal(elsewhere.error, true);
  // It sees only «Отчёты» and its works.
  const listed = await mcp(limited.secret, "polka_list", {});
  assert.deepEqual(listed.value.items.map((item: any) => item.title), ["Отчёт"]);
  const folders = await mcp(limited.secret, "polka_list_folders", {});
  assert.deepEqual(folders.value.items.map((item: any) => item.name), ["Отчёты"]);
  const hidden = await mcp(limited.secret, "polka_status", { artifactId: personal.value.artifactId });
  assert.equal(hidden.error, true);
  // Nor move its work out, nor manage folders.
  const moved = await mcp(limited.secret, "polka_move", { key: randomUUID(), artifactIds: [saved.value.artifactId], folderId: other });
  assert.equal(moved.error, true);
  const created = await mcp(limited.secret, "polka_create_folder", { key: randomUUID(), name: "Новая" });
  assert.equal(created.error, true);
  // The unlimited agent sees both.
  const all = await mcp(whole.secret, "polka_list", {});
  assert.deepEqual(all.value.items.map((item: any) => item.title).sort(), ["Личное", "Отчёт"]);
});
