// «Сохранить как ссылку» (docs/specs/SAVED_LINKS.md): a link kept as a work.
// Saving through the web route and MCP, idempotency, the content filter on
// the address (listed domains) and note, no request to an AI chat for its
// title, the owner's «Открыть ↗» redirect, and what a recipient of a share
// link gets. Plus the card the shelf, work page and recipient page draw.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { authenticateServiceToken, MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { pageTitle, saveLink, saveLinkFromAgent } from "../apps/server/saved-links.ts";
import { mcpToolCatalog } from "../apps/server/agent-discovery.ts";
import { LINK_MIME } from "../packages/contracts/index.ts";
import { LinkCard, LinkCover, recipientAccessNote } from "../apps/web/src/entities/link/index.tsx";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

async function call(method: any, url: string, body?: unknown, cookie = "", bearer?: string) {
  return app.inject({
    method,
    url,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    payload: body as any,
  });
}
async function login(name: string) {
  const response = await call("POST", "/api/login", { name, password });
  assert.equal(response.statusCode, 200, response.body);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

const ARTIFACT = "https://claude.ai/artifact/F49sUXozTkEFzFawwHGSxo";

test("a link is saved as a work, idempotently, and opens only for its owner", async () => {
  const name = "links-" + randomBytes(5).toString("hex");
  const owner = await createAccount(name, password);
  const otherName = "links-other-" + randomBytes(5).toString("hex");
  await createAccount(otherName, password);
  const cookie = await login(name);
  const body = { key: randomUUID(), url: ARTIFACT, title: "План бюджета", note: "Черновик из Claude" };
  const saved = await call("POST", "/api/links", body, cookie);
  assert.equal(saved.statusCode, 200, saved.body);
  const receipt = saved.json();
  assert.equal(receipt.title, "План бюджета");
  assert.equal(receipt.url, ARTIFACT);
  // The same key again: the same work, not a second one.
  assert.equal((await call("POST", "/api/links", body, cookie)).json().revisionId, receipt.revisionId);
  const work = (await call("GET", `/api/artifacts/${receipt.artifactId}`, undefined, cookie)).json();
  assert.equal(work.revision.mime, LINK_MIME);
  assert.deepEqual(work.revision.link, { host: "claude.ai", service: "claude" });
  assert.equal(work.revision.filename, "claude.ai.link.json");
  // The file is {v, url, note}.
  const file = await call("GET", `/api/revisions/${receipt.revisionId}/bytes`, undefined, cookie);
  assert.deepEqual(JSON.parse(file.body), { v: 1, url: ARTIFACT, note: "Черновик из Claude" });
  // «Открыть ↗»: a redirect to the original for the owner, without a referrer; nothing for anyone else.
  const open = await call("GET", `/api/revisions/${receipt.revisionId}/open`, undefined, cookie);
  assert.equal(open.statusCode, 303);
  assert.equal(open.headers.location, ARTIFACT);
  assert.equal(open.headers["referrer-policy"], "no-referrer");
  assert.equal((await call("GET", `/api/revisions/${receipt.revisionId}/open`, undefined, await login(otherName))).statusCode, 404);
  assert.equal((await call("GET", `/api/revisions/${receipt.revisionId}/open`)).statusCode, 401);
  // A default title from the provider table when none is given.
  const untitled = await saveLink(owner, { key: randomUUID(), url: "https://chatgpt.com/share/68063082-c2d8-8012-8d45-fa674aa1c1ed" });
  assert.equal(untitled.title, "Чат ChatGPT");
  // Not a link: refused.
  for (const url of ["javascript:alert(1)", "ftp://example.com/x", "https://user:pass@example.com/", "not a url"])
    assert.equal((await call("POST", "/api/links", { key: randomUUID(), url }, cookie)).statusCode, 400, url);
});

test("a shared link work gives the recipient the address and note, nothing else", async () => {
  const name = "links-share-" + randomBytes(5).toString("hex");
  await createAccount(name, password);
  const cookie = await login(name);
  const saved = (await call("POST", "/api/links", { key: randomUUID(), url: "https://example.org/report", title: "Отчёт" }, cookie)).json();
  const shared = await call("POST", `/api/artifacts/${saved.artifactId}/share`, { expectedRevisionId: saved.revisionId, expiresInDays: 7 }, cookie);
  assert.equal(shared.statusCode, 200, shared.body);
  const token = new URL(shared.json().share.url).hash.slice(1);
  const resolved = await call("POST", "/api/resolve", { token });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(resolved.json().revision.mime, LINK_MIME);
  assert.deepEqual(resolved.json().revision.link, { host: "example.org", service: null });
  const bytes = await call("GET", "/api/view/bytes", undefined, "", resolved.json().grant);
  assert.equal(bytes.statusCode, 200);
  assert.deepEqual(JSON.parse(bytes.body), { v: 1, url: "https://example.org/report", note: null });
  assert.match(String(bytes.headers["content-security-policy"]), /sandbox/);
});

test("the content filter reads the address, title and note: listed domains and categories", async () => {
  const owner = await createAccount("links-filter-" + randomBytes(5).toString("hex"), password);
  const logger = await saveLink(owner, { key: randomUUID(), url: "https://iplogger.org/2abc", title: "Смешные котики" });
  const gambling = await saveLink(owner, {
    key: randomUUID(),
    url: "https://example.net/",
    title: "Бонус",
    note: "Онлайн казино Вулкан: фриспины за регистрацию, бонус на депозит, рабочее зеркало. Играть на деньги!",
  });
  const filter = async (revisionId: string) =>
    (await db.query("SELECT content_filter FROM revisions WHERE id=$1", [revisionId])).rows[0].content_filter;
  const first = await filter(logger.revisionId);
  assert.ok(first.domains?.includes("iplogger.org"), JSON.stringify(first));
  assert.ok((await filter(gambling.revisionId)).hits?.gambling);
});

test("an AI chat's link is never opened for its title; agents save links with the capture scope", async () => {
  const enabled = config.URL_IMPORT_ENABLED;
  config.URL_IMPORT_ENABLED = true;
  try {
    // These return before any request: no robots.txt, no page.
    for (const url of [
      ARTIFACT,
      "https://chatgpt.com/share/68063082-c2d8-8012-8d45-fa674aa1c1ed",
      "https://gemini.google.com/share/abc123def",
      "https://v0.app/chat/demo",
      "https://gist.github.com/octocat/aa5a315d61ae9438b18d",
    ])
      assert.equal(await pageTitle(new URL(url)), null, url);
  } finally {
    config.URL_IMPORT_ENABLED = enabled;
  }
  const owner = await createAccount("links-agent-" + randomBytes(5).toString("hex"), password);
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'links-agent',ARRAY['capture'],$5,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(token), MCP_AUDIENCE],
  );
  const actor = await authenticateServiceToken(token, MCP_AUDIENCE, "capture");
  const receipt = await saveLinkFromAgent(actor, { key: randomUUID(), url: ARTIFACT, note: "from the agent" });
  assert.equal(receipt.title, "Артефакт Claude");
  const {
    rows: [row],
  } = await db.query("SELECT r.mime,a.tenant_id FROM revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE r.id=$1", [receipt.revisionId]);
  assert.equal(row.mime, LINK_MIME);
  assert.equal(row.tenant_id, owner.tenant);
  const tool = mcpToolCatalog().find((entry) => entry.name === "polka_save_link");
  assert.deepEqual(tool?.scopes, ["capture"]);
});

test("the link card: service badge, title, host, «Открыть» to the original, and who can open it", () => {
  const card = renderToStaticMarkup(
    React.createElement(LinkCard, {
      title: "План бюджета",
      host: "claude.ai",
      service: "claude",
      href: ARTIFACT,
      note: "Черновик",
      hint: recipientAccessNote("claude.ai", "claude", "recipient"),
    }),
  );
  assert.match(card, /data-service="Claude"/);
  assert.match(card, />Cl</);
  assert.match(card, /План бюджета/);
  assert.match(card, /claude\.ai/);
  assert.match(card, /href="https:\/\/claude\.ai\/artifact\/F49sUXozTkEFzFawwHGSxo" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.match(card, /Открыть/);
  assert.match(card, /если автор включил доступ по ссылке/);
  assert.match(recipientAccessNote("claude.ai", "claude"), /Получатель откроет артефакт Claude, если автор включил доступ по ссылке/);
  assert.match(recipientAccessNote("example.org", null), /Получатель откроет оригинал на example\.org/);
  const cover = renderToStaticMarkup(React.createElement(LinkCover, { title: "Отчёт", host: "example.org", service: null }));
  assert.match(cover, /Отчёт/);
  assert.match(cover, /example\.org/);
});
