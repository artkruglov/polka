// An agent limited to a folder (docs/specs/EXTENSIONS.md, policies.
// agentScope): it saves into the folder, sees and changes only works there,
// and does not manage folders. The same shelf's other agent is unaffected.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { PolkaExtension } from "../packages/extension-api/index.ts";
import { useExtensions } from "../apps/server/extensions.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { listEventsForAgent } from "../apps/server/agent-events.ts";
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
    ? response.body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("")
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
  await db.query("INSERT INTO folders(id,tenant_id,name) VALUES($1,$3,'Отчёты'),($2,$3,'Личное')", [
    reports,
    other,
    owner.tenant,
  ]);
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
  const personal = await mcp(whole.secret, "polka_publish", {
    key: randomUUID(),
    title: "Личное",
    html: page("Личное"),
    folderId: other,
  });
  assert.equal(personal.error, false, JSON.stringify(personal.value));
  // The limited agent saves without a folder: the work goes to «Отчёты».
  const saved = await mcp(limited.secret, "polka_publish", { key: randomUUID(), title: "Отчёт", html: page("Отчёт") });
  assert.equal(saved.error, false, JSON.stringify(saved.value));
  const {
    rows: [work],
  } = await db.query("SELECT folder_id FROM artifacts WHERE id=$1", [saved.value.artifactId]);
  assert.equal(work.folder_id, reports);
  // Into another folder: refused.
  const elsewhere = await mcp(limited.secret, "polka_publish", {
    key: randomUUID(),
    title: "Туда",
    html: page("Туда"),
    folderId: other,
  });
  assert.equal(elsewhere.error, true);
  // It sees only «Отчёты» and its works.
  const listed = await mcp(limited.secret, "polka_list", {});
  assert.deepEqual(
    listed.value.items.map((item: any) => item.title),
    ["Отчёт"],
  );
  const folders = await mcp(limited.secret, "polka_list_folders", {});
  assert.deepEqual(
    folders.value.items.map((item: any) => item.name),
    ["Отчёты"],
  );
  const hidden = await mcp(limited.secret, "polka_status", { artifactId: personal.value.artifactId });
  assert.equal(hidden.error, true);
  // Nor move its work out, nor manage folders.
  const moved = await mcp(limited.secret, "polka_move", {
    key: randomUUID(),
    artifactIds: [saved.value.artifactId],
    folderId: other,
  });
  assert.equal(moved.error, true);
  const created = await mcp(limited.secret, "polka_create_folder", { key: randomUUID(), name: "Новая" });
  assert.equal(created.error, true);
  // The unlimited agent sees both.
  const all = await mcp(whole.secret, "polka_list", {});
  assert.deepEqual(all.value.items.map((item: any) => item.title).sort(), ["Личное", "Отчёт"]);
});

test("a limited agent lists templates of its folders only", async () => {
  const inside = await mcp(whole.secret, "polka_publish", {
    key: randomUUID(),
    title: "Шаблон отчёта",
    html: page("Шаблон отчёта"),
    folderId: reports,
  });
  const outside = await mcp(whole.secret, "polka_publish", {
    key: randomUUID(),
    title: "Личный шаблон",
    html: page("Личный шаблон"),
    folderId: other,
  });
  for (const saved of [inside, outside]) {
    assert.equal(saved.error, false, JSON.stringify(saved.value));
    await db.query(
      "INSERT INTO template_releases(id,artifact_id,revision_id,title,summary,rules,questions) SELECT $1,$2,latest_revision_id,title,'Сводка','[]'::jsonb,'[]'::jsonb FROM artifacts WHERE id=$2",
      [randomUUID(), saved.value.artifactId],
    );
  }
  const limitedList = await mcp(limited.secret, "polka_list_templates", {});
  assert.equal(limitedList.error, false, JSON.stringify(limitedList.value));
  assert.deepEqual(
    limitedList.value.items.map((item: any) => item.title),
    ["Шаблон отчёта"],
  );
  const wholeList = await mcp(whole.secret, "polka_list_templates", {});
  assert.deepEqual(wholeList.value.items.map((item: any) => item.title).sort(), ["Личный шаблон", "Шаблон отчёта"]);
});

test("a limited agent's retried upload with a source address is the same upload, not a conflict", async () => {
  const { beginUpload, sameUploadRequest } = await import("../apps/server/artifacts.ts");
  const bytes = Buffer.from(page("Источник"));
  const body = {
    key: randomUUID(),
    title: "Источник",
    filename: "page.html",
    mime: "text/html" as const,
    size: bytes.length,
    sha256: sha256(bytes),
    sourceUrl: "https://example.com/report",
  };
  // The scope adds folderId after sourceUrl; the stored request, parsed
  // again, has it before: the order of fields must not matter.
  const actor = { id: owner.id, tenant: owner.tenant, connectionId: limited.id };
  const first = await beginUpload(actor, body);
  const retried = await beginUpload(actor, body);
  assert.equal(retried.uploadId, first.uploadId);
  // Another file under the same key is still refused.
  await assert.rejects(beginUpload(actor, { ...body, title: "Другое" }), (error: any) => error.status === 409);
  assert.equal(sameUploadRequest({ ...body, folderId: reports }, { folderId: reports, ...body }), true);
  assert.equal(sameUploadRequest({ ...body, folderId: reports }, { ...body, folderId: other }), false);
});

test("every MCP tool answers a failure as a structured error, never with the raw database text", async () => {
  const errors: string[] = [];
  const logged = console.error;
  const query = pg.Client.prototype.query;
  console.error = (line: unknown) => void errors.push(String(line));
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text;
    // The folder list meets a real database error (42P01, naming a relation).
    if (text?.includes("FROM folders"))
      args = ["SELECT * FROM internal_secret", ...args.slice(1).filter((arg) => typeof arg === "function")];
    return (query as (...rest: unknown[]) => unknown).apply(this, args);
  } as typeof query;
  let failed;
  try {
    failed = await mcp(whole.secret, "polka_list_folders", {});
  } finally {
    pg.Client.prototype.query = query;
    console.error = logged;
  }
  assert.equal(failed.error, true);
  assert.equal(failed.value.code, "internal");
  assert.match(failed.value.message, /Не удалось завершить действие/);
  assert.doesNotMatch(JSON.stringify(failed.value), /internal_secret|relation/);
  const entry = errors.map((line) => JSON.parse(line)).find((item) => item.event === "mcp.tool.failed");
  assert.deepEqual(
    { tool: entry?.tool, code: entry?.code, sqlstate: entry?.sqlstate },
    { tool: "polka_list_folders", code: "internal", sqlstate: "42P01" },
  );
  // A refusal keeps its code and words, whichever tool refuses.
  const refused = await mcp(limited.secret, "polka_create_folder", { key: randomUUID(), name: "Ещё" });
  assert.equal(refused.error, true);
  assert.equal(refused.value.code, "forbidden");
  assert.match(refused.value.message, /Агент, подключённый к папке/);
});

test("a limited agent's events feed holds the events of its folders only", async () => {
  const actorOf = (id: string) => ({
    accountId: owner.id,
    tenantId: owner.tenant,
    connectionId: id,
    scopes: ["context", "read"] as never,
    audience: MCP_AUDIENCE,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  const tail = await listEventsForAgent(actorOf(limited.id), {});
  const inside = await mcp(whole.secret, "polka_publish", {
    key: randomUUID(),
    title: "События внутри",
    html: page("в"),
    folderId: reports,
  });
  const outside = await mcp(whole.secret, "polka_publish", {
    key: randomUUID(),
    title: "События снаружи",
    html: page("с"),
    folderId: other,
  });
  assert.equal(inside.error || outside.error, false);
  let seen: string[] = [];
  for (let tries = 0; tries < 60 && !seen.length; tries++) {
    seen = (await listEventsForAgent(actorOf(limited.id), { after: tail.nextCursor })).events.map(
      (event) => event.artifactId,
    );
    if (!seen.length) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(seen, [inside.value.artifactId]);
  // The unlimited connection sees both.
  const all = await listEventsForAgent(actorOf(whole.id), { after: tail.nextCursor });
  assert.deepEqual(
    all.events.map((event) => event.artifactId).sort(),
    [inside.value.artifactId, outside.value.artifactId].sort(),
  );
});
