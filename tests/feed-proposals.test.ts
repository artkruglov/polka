// Proposals to «Лента» from a department shelf (docs/specs/DISCOVER_V2.md,
// «Предложение с полки отдела»): a curator proposes one version, the operator
// decides with npm run feed:proposals; nothing is published by the proposal.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { decideFeedProposal, listFeedProposalsForOperator } from "../apps/server/feed-proposals.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { runFeedProposals } from "../scripts/feed-proposals.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
const teamShelves = config.TEAM_SHELVES;
type Account = Awaited<ReturnType<typeof createAccount>>;
let admin: Account, curator: Account, author: Account, reader: Account, stranger: Account;
let shelf: { id: string };
const sessions = new Map<string, string>();
const page = "<!doctype html><html><head><title>Разбор</title></head><body><h1>Разбор воронки</h1></body></html>";

const call = (method: any, url: string, account: Account, body?: unknown, onShelf?: string) =>
  app.inject({
    method,
    url,
    headers: {
      origin,
      cookie: `polka_session=${sessions.get(account.name)}`,
      ...(onShelf ? { "x-polka-shelf": onShelf } : {}),
      ...(Buffer.isBuffer(body) ? { "content-type": "application/octet-stream" } : {}),
    },
    payload: body as any,
  });

async function save(account: Account, title: string, text: string, onShelf?: string, mime = "text/html") {
  const body = Buffer.from(text);
  const start = await call(
    "POST",
    "/api/uploads",
    account,
    {
      key: randomUUID(),
      title,
      filename: mime === "text/html" ? "page.html" : "note.txt",
      mime,
      size: body.length,
      sha256: sha256(body),
    },
    onShelf,
  );
  assert.equal(start.statusCode, 200, start.body);
  const uploadId = start.json().uploadId;
  assert.equal((await call("PUT", `/api/uploads/${uploadId}/bytes`, account, body, onShelf)).statusCode, 200);
  const done = await call("POST", `/api/uploads/${uploadId}/finalize`, account, {}, onShelf);
  assert.equal(done.statusCode, 200, done.body);
  return done.json() as { artifactId: string; revisionId: string };
}

const form = (revisionId: string) => ({
  revisionId,
  title: "Разбор воронки продаж",
  summary: "Как отдел считает воронку и где теряются заявки",
  rights: true,
  noPersonalData: true,
});

before(async () => {
  config.TEAM_SHELVES = "on";
  const suffix = randomBytes(5).toString("hex");
  admin = await createAccount(`feed-admin-${suffix}`, password);
  curator = await createAccount(`feed-curator-${suffix}`, password);
  author = await createAccount(`feed-author-${suffix}`, password);
  reader = await createAccount(`feed-reader-${suffix}`, password);
  stranger = await createAccount(`feed-stranger-${suffix}`, password);
  for (const account of [admin, curator, author, reader, stranger]) {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin },
      payload: { name: account.name, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    sessions.set(account.name, login.cookies[0].value);
  }
  await db.query("UPDATE accounts SET company_admin=true WHERE id=$1", [admin.id]);
  shelf = (await call("POST", "/api/shelves", admin, { name: "Отдел продаж" })).json();
  for (const [account, role] of [[curator, "curator"], [author, "author"], [reader, "reader"]] as const) {
    const added = await call("POST", `/api/shelves/${shelf.id}/members`, admin, { who: account.name, role });
    assert.equal(added.statusCode, 200, added.body);
  }
});

after(async () => {
  config.TEAM_SHELVES = teamShelves;
  await app.close();
  await db.end();
  s3.destroy();
});

test("a curator proposes a version; authors, readers and strangers cannot; one waits at a time", async () => {
  const work = await save(author, "Воронка", page, shelf.id);
  const url = `/api/artifacts/${work.artifactId}/feed-proposal`;
  // Nobody has proposed it yet; every member may see that.
  assert.deepEqual((await call("GET", url, reader, undefined, shelf.id)).json(), { proposal: null });
  assert.equal((await call("GET", url, stranger, undefined, shelf.id)).statusCode, 404);

  for (const account of [author, reader]) {
    const refused = await call("POST", url, account, form(work.revisionId), shelf.id);
    assert.equal(refused.statusCode, 403, refused.body);
  }
  assert.equal((await call("POST", url, stranger, form(work.revisionId), shelf.id)).statusCode, 404);
  // Both confirmations are required.
  const unconfirmed = await call("POST", url, curator, { ...form(work.revisionId), rights: false }, shelf.id);
  assert.equal(unconfirmed.statusCode, 400, unconfirmed.body);

  const proposed = await call("POST", url, curator, form(work.revisionId), shelf.id);
  assert.equal(proposed.statusCode, 200, proposed.body);
  const { proposal } = proposed.json();
  assert.equal(proposal.state, "pending");
  assert.equal(proposal.revisionId, work.revisionId);
  assert.equal(proposal.revisionNumber, 1);
  assert.equal(proposal.proposedBy, curator.name);
  assert.equal((await call("GET", url, reader, undefined, shelf.id)).json().proposal.id, proposal.id);

  const again = await call("POST", url, admin, form(work.revisionId), shelf.id);
  assert.equal(again.statusCode, 409, again.body);
  assert.match(again.body, /ждёт решения Редакции/);

  // Nothing appears in «Лента» by the proposal.
  const feed = (await app.inject({ method: "GET", url: "/api/editorial" })).body;
  assert.doesNotMatch(feed, /Разбор воронки продаж/);
  const audit = await db.query(
    "SELECT action FROM audit_outbox WHERE tenant_id=$1 AND target_id=$2 AND action LIKE 'feed.%'",
    [shelf.id, work.artifactId],
  );
  assert.deepEqual(audit.rows.map((row) => row.action), ["feed.proposed"]);

  // Withdraw: an author cannot, a curator can; then it may be proposed again.
  assert.equal((await call("POST", `${url}/withdraw`, author, {}, shelf.id)).statusCode, 403);
  const withdrawn = await call("POST", `${url}/withdraw`, admin, {}, shelf.id);
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  assert.equal(withdrawn.json().proposal.state, "withdrawn");
  assert.equal((await call("POST", `${url}/withdraw`, admin, {}, shelf.id)).statusCode, 409);
  assert.equal((await call("POST", url, curator, form(work.revisionId), shelf.id)).statusCode, 200);
});

test("only a page that opens in the ordinary viewer, only from a department shelf", async () => {
  const note = await save(author, "Заметка", "Просто текст", shelf.id, "text/plain");
  const refused = await call("POST", `/api/artifacts/${note.artifactId}/feed-proposal`, curator, form(note.revisionId), shelf.id);
  assert.equal(refused.statusCode, 422, refused.body);
  // A personal shelf proposes nothing: «Лента» takes department works only.
  const own = await save(curator, "Своё", page);
  const personal = await call("POST", `/api/artifacts/${own.artifactId}/feed-proposal`, curator, form(own.revisionId));
  assert.equal(personal.statusCode, 409, personal.body);
  // A revision of another work is not this work's.
  const other = await save(author, "Другая", page, shelf.id);
  const foreign = await call("POST", `/api/artifacts/${other.artifactId}/feed-proposal`, curator, form(own.revisionId), shelf.id);
  assert.equal(foreign.statusCode, 404, foreign.body);
  // With the flag off a department shelf is not there at all.
  config.TEAM_SHELVES = "off";
  try {
    const off = await call("POST", `/api/artifacts/${other.artifactId}/feed-proposal`, curator, form(other.revisionId), shelf.id);
    assert.notEqual(off.statusCode, 200);
    assert.equal(
      (await db.query("SELECT 1 FROM feed_proposals WHERE artifact_id=$1", [other.artifactId])).rowCount,
      0,
    );
  } finally {
    config.TEAM_SHELVES = "on";
  }
});

test("the trash withdraws a waiting proposal", async () => {
  const work = await save(author, "В корзину", page, shelf.id);
  const url = `/api/artifacts/${work.artifactId}/feed-proposal`;
  assert.equal((await call("POST", url, curator, form(work.revisionId), shelf.id)).statusCode, 200);
  const artifact = (await call("GET", `/api/artifacts/${work.artifactId}`, curator, undefined, shelf.id)).json();
  const trashed = await call(
    "POST",
    `/api/artifacts/${work.artifactId}/trash`,
    curator,
    { expectedLifecycleVersion: artifact.lifecycleVersion, expectedRevisionId: work.revisionId },
    shelf.id,
  );
  assert.equal(trashed.statusCode, 200, trashed.body);
  const { rows } = await db.query("SELECT state FROM feed_proposals WHERE artifact_id=$1", [work.artifactId]);
  assert.deepEqual(rows.map((row) => row.state), ["withdrawn"]);
});

test("the operator lists, exports the exact bytes and decides; the shelf sees the decision", async () => {
  const work = await save(author, "Для Редакции", page, shelf.id);
  const url = `/api/artifacts/${work.artifactId}/feed-proposal`;
  const { proposal } = (await call("POST", url, curator, form(work.revisionId), shelf.id)).json();
  const waiting = await listFeedProposalsForOperator();
  const listed = waiting.find((item) => item.id === proposal.id);
  assert.equal(listed?.shelfName, "Отдел продаж");
  assert.equal(listed?.workTitle, "Для Редакции");

  const root = await mkdtemp(join(tmpdir(), "polka-feed-"));
  try {
    assert.equal(await runFeedProposals(["export", proposal.id, "razbor-voronki"], root), 0);
    assert.equal(await readFile(join(root, "content/editorial/razbor-voronki/index.html"), "utf8"), page);
    // The same slug is never overwritten.
    assert.equal(await runFeedProposals(["export", proposal.id, "razbor-voronki"], root), 1);
    assert.equal(await runFeedProposals(["export", proposal.id, "Bad Slug"], root), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  await assert.rejects(decideFeedProposal(proposal.id, "rejected", " "), /почему/);
  assert.equal(await runFeedProposals(["decide", proposal.id, "rejected", "Нужны", "источники"]), 0);
  const seen = (await call("GET", url, reader, undefined, shelf.id)).json().proposal;
  assert.equal(seen.state, "rejected");
  assert.equal(seen.reason, "Нужны источники");
  // A decision is final; the shelf may propose again.
  await assert.rejects(decideFeedProposal(proposal.id, "published", null), /рассмотрено/);
  assert.equal((await call("POST", `${url}/withdraw`, curator, {}, shelf.id)).statusCode, 409);
  const next = (await call("POST", url, curator, form(work.revisionId), shelf.id)).json().proposal;
  assert.deepEqual(await decideFeedProposal(next.id, "published", null), { id: next.id, state: "published" });
  assert.ok(!(await listFeedProposalsForOperator()).some((item) => item.artifactId === work.artifactId));
  assert.equal((await listFeedProposalsForOperator(true)).filter((item) => item.artifactId === work.artifactId).length, 2);
});
