// Search over the text of works (docs/specs/CONTENT_SEARCH.md): what a save
// indexes (a page's visible text, a bundle's JSX, a text file), prefix
// matches and snippets on the shelf and in polka_list, the latest version
// only, the owner only, text hidden while a moderation block holds, and the
// backfill of works saved before.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { listArtifactsForAgent } from "../apps/server/agent-management.ts";
import { backfillSearch } from "../apps/server/search-backfill.ts";
import { MCP_AUDIENCE, type ServiceActor } from "../apps/server/service-auth.ts";
import { prefixQuery, SearchText, addScriptText } from "../apps/server/search-text.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import {
  SEARCH_MATCH_END,
  SEARCH_MATCH_START,
} from "../packages/contracts/index.ts";
import { prepareCapture } from "../scripts/prepare-capture.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;
let ownerCookie = "";
let otherCookie = "";
let bundleDir = "";

async function call(method: any, url: string, body?: any, cookie = ownerCookie) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      cookie,
      ...(Buffer.isBuffer(body) ? { "content-type": "application/octet-stream" } : {}),
    },
    payload: body,
  });
}

async function login(name: string) {
  const response = await call("POST", "/api/login", { name, password }, "");
  assert.equal(response.statusCode, 200, response.body);
  return `${response.cookies[0].name}=${response.cookies[0].value}`;
}

async function saveSingle(
  source: string,
  patch: Record<string, unknown> = {},
  mime = "text/html",
) {
  const bytes = Buffer.from(source);
  const begun = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Квартальный отчёт",
    filename: mime === "text/html" ? "index.html" : "notes.txt",
    mime,
    size: bytes.length,
    sha256: sha256(bytes),
    ...patch,
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const uploadId = begun.json().uploadId as string;
  assert.equal(
    (await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes)).statusCode,
    200,
  );
  const finalized = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(finalized.statusCode, 200, finalized.body);
  return finalized.json() as { artifactId: string; revisionId: string };
}

async function saveBundle(title: string) {
  const prepared = await prepareCapture(bundleDir, "index.html", [
    "index.html",
    "app.js",
  ]);
  const begun = await call("POST", "/api/bundle-uploads", {
    key: randomUUID(),
    title,
    manifest: prepared.manifest,
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const uploadId = begun.json().uploadId as string;
  for (const [index, file] of (prepared.manifest as any).files.entries()) {
    const supplied = prepared.files.find((item) => item.path === file.path)!;
    const uploaded = await call(
      "PUT",
      `/api/bundle-uploads/${uploadId}/files/${index}`,
      Buffer.from(supplied.data, supplied.encoding),
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
  }
  const finalized = await call("POST", `/api/bundle-uploads/${uploadId}/finalize`, {});
  assert.equal(finalized.statusCode, 200, finalized.body);
  return finalized.json() as { artifactId: string; revisionId: string };
}

async function search(q: string, cookie = ownerCookie) {
  const response = await call(
    "GET",
    `/api/artifacts?${new URLSearchParams({ q })}`,
    undefined,
    cookie,
  );
  assert.equal(response.statusCode, 200, response.body);
  return response.json().items as Array<{ id: string; snippet?: string }>;
}

async function agent(account: typeof owner) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_connections(
       id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at
     ) VALUES($1,$2,$3,$4,'search test',$5,$6,now()+interval '1 day')`,
    [id, account.tenant, account.id, sha256(randomBytes(32)), ["read"], MCP_AUDIENCE],
  );
  return {
    accountId: account.id,
    tenantId: account.tenant,
    connectionId: id,
    scopes: ["read"],
    audience: MCP_AUDIENCE,
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  } as ServiceActor;
}

before(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "polka-search-"));
  await writeFile(
    join(bundleDir, "index.html"),
    '<!doctype html><title>Дашборд</title><div id="root"></div><script type="module" src="app.js"></script>',
  );
  await writeFile(
    join(bundleDir, "app.js"),
    `export default function App() {
  return <main className="flex items-center gap-4">
    <h1>Forecast by region</h1>
    <p>Прогноз выручки по регионам на четвёртый квартал</p>
  </main>;
}
`,
  );
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`search-a-${suffix}`, password);
  other = await createAccount(`search-b-${suffix}`, password);
  ownerCookie = await login(owner.name);
  otherCookie = await login(other.name);
});

after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
  await app.close();
  await db.end();
  s3.destroy();
});

test("a page is found by its visible text, with the found words marked", async () => {
  const saved = await saveSingle(
    `<!doctype html><title>Отчёт</title>
     <p>Расчёт скидок для ритейла на третий квартал.</p>
     <div hidden>невидимая приписка</div>
     <style>.плашка{color:red}</style>`,
  );
  const found = await search("ритейл");
  const item = found.find((entry) => entry.id === saved.artifactId);
  assert.ok(item, "found by a word of its text");
  assert.ok(item.snippet?.includes(`${SEARCH_MATCH_START}ритейла${SEARCH_MATCH_END}`), String(item.snippet));
  // Prefixes and every word: «скид» finds «скидок», both words must match.
  assert.ok((await search("скид кварт")).some((entry) => entry.id === saved.artifactId));
  assert.ok(!(await search("скид запасы")).some((entry) => entry.id === saved.artifactId));
  // Hidden text and styles are not what a reader sees.
  assert.ok(!(await search("невидимая")).some((entry) => entry.id === saved.artifactId));
  assert.ok(!(await search("плашка")).some((entry) => entry.id === saved.artifactId));
  // A title match still works, without a snippet.
  const byTitle = (await search("Квартальный")).find((entry) => entry.id === saved.artifactId);
  assert.ok(byTitle);
  assert.equal(byTitle.snippet, undefined);
});

test("a bundle is found by its JSX text; class lists are not text", async () => {
  const saved = await saveBundle("Дашборд продаж");
  assert.ok((await search("прогноз выручки")).some((entry) => entry.id === saved.artifactId));
  assert.ok((await search("forecast region")).some((entry) => entry.id === saved.artifactId));
  assert.ok(!(await search("items-center")).some((entry) => entry.id === saved.artifactId));
});

test("a text file is found by its text", async () => {
  const saved = await saveSingle(
    "Заметки со встречи: переговоры с поставщиком упаковки.",
    {},
    "text/plain",
  );
  assert.ok((await search("поставщик")).some((entry) => entry.id === saved.artifactId));
});

test("only the latest version is searched, and only by its owner", async () => {
  const first = await saveSingle("<!doctype html><p>Черновик про логистику складов.</p>");
  assert.ok((await search("логистик")).some((entry) => entry.id === first.artifactId));
  assert.ok(!(await search("логистик", otherCookie)).some((entry) => entry.id === first.artifactId));
  await saveSingle("<!doctype html><p>Итог про маркетинговый бюджет.</p>", {
    artifactId: first.artifactId,
    baseRevisionId: first.revisionId,
  });
  assert.ok(!(await search("логистик")).some((entry) => entry.id === first.artifactId));
  assert.ok((await search("бюджет")).some((entry) => entry.id === first.artifactId));
});

test("polka_list finds by text and returns a plain snippet", async () => {
  const saved = await saveSingle("<!doctype html><p>План найма аналитиков данных.</p>");
  const actor = await agent(owner);
  const listed = await listArtifactsForAgent(actor, { query: "аналитик" });
  const item = listed.items.find((entry) => entry.id === saved.artifactId) as any;
  assert.ok(item, "found by the agent");
  assert.match(item.snippet, /«аналитиков»/);
  assert.equal(item.revision.id, saved.revisionId);
  const strangers = await listArtifactsForAgent(await agent(other), { query: "аналитик" });
  assert.ok(!strangers.items.some((entry) => entry.id === saved.artifactId));
});

test("a blocked version's text neither matches nor shows until the block is released", async () => {
  const saved = await saveSingle("<!doctype html><p>Сводка по тендеру на ремонт.</p>");
  assert.ok((await search("тендер")).some((entry) => entry.id === saved.artifactId));
  const blockId = randomUUID();
  await db.query(
    `INSERT INTO moderation_blocks(id,tenant_id,artifact_id,revision_id,sha256,category,isolated)
     VALUES($1,$2,$3,$4,$5,'spam',true)`,
    [blockId, owner.tenant, saved.artifactId, saved.revisionId, "a".repeat(64)],
  );
  assert.ok(!(await search("тендер")).some((entry) => entry.id === saved.artifactId));
  await db.query("UPDATE moderation_blocks SET released_at=now() WHERE id=$1", [blockId]);
  assert.ok((await search("тендер")).some((entry) => entry.id === saved.artifactId));
});

test("the backfill indexes works saved before search, once", async () => {
  const saved = await saveSingle("<!doctype html><p>Инструкция по возврату оборудования.</p>");
  await db.query("DELETE FROM artifact_search WHERE artifact_id=$1", [saved.artifactId]);
  assert.ok(!(await search("возврат")).some((entry) => entry.id === saved.artifactId));
  const report = await backfillSearch({ artifactIds: [saved.artifactId] });
  assert.equal(report.indexed, 1);
  assert.ok((await search("возврат")).some((entry) => entry.id === saved.artifactId));
  const again = await backfillSearch({ artifactIds: [saved.artifactId] });
  assert.equal(again.scanned, 0);
});

test("the row goes with the work", async () => {
  const saved = await saveSingle("<!doctype html><p>Временная заметка.</p>");
  await db.query("UPDATE artifacts SET latest_revision_id=NULL WHERE id=$1", [saved.artifactId]);
  await db.query("DELETE FROM revisions WHERE artifact_id=$1", [saved.artifactId]);
  const { rowCount } = await db.query(
    "SELECT 1 FROM artifact_search WHERE artifact_id=$1",
    [saved.artifactId],
  );
  assert.equal(rowCount, 0);
});

test("queries and script text: no tsquery syntax gets through", () => {
  assert.equal(prefixQuery("  "), null);
  assert.equal(prefixQuery("Скидки & | ! (ритейл):*"), "'скидки':* & 'ритейл':*");
  assert.equal(prefixQuery("github.com anna@example.ru 3.14."), "'github.com':* & 'anna@example.ru':* & '3.14':*");
  assert.equal(prefixQuery("it's"), "'it':* & 's':*");
  assert.equal(prefixQuery("a b c d e f g h i j")?.split(" & ").length, 8);
  const text = new SearchText();
  addScriptText(
    'const cls = "px-4 py-2 rounded"; const t = "Итоги года"; x = a>b?c:{d};',
    text,
    "cyrillic",
  );
  assert.equal(text.value(), "Итоги года");
});

test("a long run of letters in a script is read in linear time", () => {
  const text = new SearchText();
  const started = performance.now();
  addScriptText(`const blob = "${"a".repeat(80_000)}"; const t = "Итоги ${"b".repeat(3_000)} года";`, text);
  addScriptText(`const s = "${"word ".repeat(700)}";`, text);
  assert.ok(performance.now() - started < 100, `${Math.round(performance.now() - started)} ms`);
  assert.doesNotMatch(text.value(), /aaaa/);
});

test("the backfill does not bring back text of a purged version", async () => {
  const saved = await saveSingle("<!doctype html><p>Удалённая модерацией сводка.</p>");
  await db.query("DELETE FROM artifact_search WHERE artifact_id=$1", [saved.artifactId]);
  await db.query("UPDATE revisions SET content_purged_at=now() WHERE id=$1", [saved.revisionId]);
  try {
    const report = await backfillSearch({ artifactIds: [saved.artifactId] });
    assert.equal(report.indexed, 0);
    const { rowCount } = await db.query("SELECT 1 FROM artifact_search WHERE artifact_id=$1", [saved.artifactId]);
    assert.equal(rowCount, 0);
  } finally {
    await db.query("UPDATE revisions SET content_purged_at=NULL WHERE id=$1", [saved.revisionId]);
  }
});

test("an address, an e-mail and a version are found as written", async () => {
  const saved = await saveSingle(
    "<!doctype html><p>Код лежит на github.com/polka, пишите на anna@example.ru, версия 3.14.</p>",
  );
  for (const query of ["github.com", "anna@example.ru", "3.14", "githu"])
    assert.ok((await search(query)).some((entry) => entry.id === saved.artifactId), query);
});
