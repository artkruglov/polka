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
         object_key,object_version,total_size
       ) VALUES($1,$2,$3,1,$4,'cursor.txt','text/plain',1,$5,$6,'fixture',1)`,
      [
        revisionId,
        owner.tenant,
        artifactId,
        owner.id,
        "0".repeat(64),
        `pagination/${artifactId}`,
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
