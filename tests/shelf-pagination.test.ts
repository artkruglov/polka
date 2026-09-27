import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";
const artifactIds: string[] = [];
// Work N is an image, a page or a text by N % 3: 8 images, 9 pages, 9 documents.
const KINDS = [
  ["cursor.png", "image/png"],
  ["cursor.html", "text/html"],
  ["cursor.txt", "text/plain"],
] as const;
const kindOf = (index: number) => (["images", "pages", "documents"] as const)[index % 3];

before(async () => {
  owner = await createAccount(
    `shelf-page-${randomBytes(6).toString("hex")}`,
    password,
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin },
    payload: { name: owner.name, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;

  for (let index = 1; index <= 26; index++) {
    const artifactId = randomUUID();
    const revisionId = randomUUID();
    artifactIds.push(artifactId);
    await db.query(
      `INSERT INTO artifacts(id,tenant_id,created_by,title,updated_at)
       VALUES($1,$2,$3,$4,$5::timestamptz)`,
      [
        artifactId,
        owner.tenant,
        owner.id,
        `Cursor microseconds ${index}`,
        `2026-09-20T12:00:00.123${String(index).padStart(3, "0")}Z`,
      ],
    );
    await db.query(
      `INSERT INTO revisions(
         id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,
         object_key,object_version,total_size,html_profile
       ) VALUES($1,$2,$3,1,$4,$7,$8,1,$5,$6,'fixture',1,
                CASE WHEN $8='text/html' THEN 'static' END)`,
      [
        revisionId,
        owner.tenant,
        artifactId,
        owner.id,
        "0".repeat(64),
        `pagination/${artifactId}`,
        ...KINDS[index % 3],
      ],
    );
    await db.query("UPDATE artifacts SET latest_revision_id=$2 WHERE id=$1", [
      artifactId,
      revisionId,
    ]);
  }
});

after(async () => {
  if (owner) {
    await db.query(
      "UPDATE artifacts SET latest_revision_id=NULL WHERE id=ANY($1::uuid[])",
      [artifactIds],
    );
    await db.query("DELETE FROM revisions WHERE artifact_id=ANY($1::uuid[])", [
      artifactIds,
    ]);
    await db.query("DELETE FROM artifacts WHERE id=ANY($1::uuid[])", [
      artifactIds,
    ]);
    await db.query("DELETE FROM sessions WHERE account_id=$1", [owner.id]);
    await db.query("DELETE FROM tenants WHERE id=$1", [owner.tenant]);
    await db.query("DELETE FROM accounts WHERE id=$1", [owner.id]);
  }
  await app.close();
  await db.end();
  s3.destroy();
});

test("web shelf cursor preserves PostgreSQL microseconds across pages", async () => {
  const seen: string[] = [];
  let cursor: string | null = null;

  do {
    const response: {
      statusCode: number;
      body: string;
      json(): unknown;
    } = await app.inject({
      method: "GET",
      url: `/api/artifacts?q=Cursor%20microseconds${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      headers: { origin, cookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    seen.push(...body.items.map((item: { id: string }) => item.id));
    cursor = body.nextCursor;
  } while (cursor);

  assert.equal(seen.length, 26);
  assert.equal(new Set(seen).size, 26);
  assert.deepEqual(new Set(seen), new Set(artifactIds));
});

type ShelfPage = {
  items: Array<{ id: string; title: string }>;
  nextCursor: string | null;
  counts?: Record<string, number>;
};

/** Every page of the shelf for this query; the counts of the first. */
async function walk(query: string) {
  const seen: ShelfPage["items"] = [];
  let cursor: string | null = null;
  let counts: ShelfPage["counts"];
  let pages = 0;
  do {
    const response: { statusCode: number; body: string; json(): unknown } = await app.inject({
      method: "GET",
      url: `/api/artifacts?q=Cursor%20microseconds&${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      headers: { origin, cookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as ShelfPage;
    if (pages++ === 0) counts = body.counts;
    else assert.equal(body.counts, undefined);
    seen.push(...body.items);
    cursor = body.nextCursor;
  } while (cursor);
  return { seen, counts, pages };
}

test("the shelf sorts the whole shelf, not the loaded page", async () => {
  const oldest = await walk("sort=old");
  assert.equal(oldest.pages, 2);
  assert.deepEqual(oldest.seen.map((item) => item.id), artifactIds);
  const newest = await walk("sort=new");
  assert.deepEqual(newest.seen.map((item) => item.id), [...artifactIds].reverse());
  const byTitle = await walk("sort=title");
  const titles = byTitle.seen.map((item) => item.title);
  assert.equal(titles.length, 26);
  assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b, "en")));
  // «Cursor microseconds 1», «… 10», «… 11»: by the words, not by the date.
  assert.deepEqual(titles.slice(0, 3), [
    "Cursor microseconds 1",
    "Cursor microseconds 10",
    "Cursor microseconds 11",
  ]);
});

test("a kind filter covers the whole shelf and the counts are the shelf's", async () => {
  const all = await walk("sort=new");
  assert.deepEqual(all.counts, { all: 26, pages: 9, documents: 9, images: 8, other: 0 });
  for (const kind of ["images", "pages", "documents"] as const) {
    const expected = artifactIds.filter((_, index) => kindOf(index + 1) === kind);
    const filtered = await walk(`sort=old&kind=${kind}`);
    assert.deepEqual(filtered.seen.map((item) => item.id), expected, kind);
    // The chips keep the numbers of every kind while one is chosen.
    assert.deepEqual(filtered.counts, all.counts, kind);
  }
  assert.deepEqual((await walk("kind=other")).seen, []);
});

test("a cursor of another order, or a bad kind or order, is refused", async () => {
  const first = await app.inject({
    method: "GET",
    url: "/api/artifacts?q=Cursor%20microseconds&sort=title",
    headers: { origin, cookie },
  });
  const { nextCursor } = first.json() as ShelfPage;
  assert.ok(nextCursor);
  for (const url of [
    `/api/artifacts?sort=new&cursor=${encodeURIComponent(nextCursor)}`,
    "/api/artifacts?sort=random",
    "/api/artifacts?kind=videos",
  ]) {
    const response = await app.inject({ method: "GET", url, headers: { origin, cookie } });
    assert.equal(response.statusCode, 400, url);
  }
});
