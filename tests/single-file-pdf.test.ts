// PDF as a single-file work (docs/specs/SINGLE_FILE_FORMATS.md, «PDF»): the
// save's checks (the header, pdf.js must open it), the text pdf.js reads for
// search, the filter, the moderator, the cover and the agent, its links
// through the same phishing checks as a page's, the publish API, and an
// install without a viewer domain (the default suite runs static-only). The
// viewer's page is in tests/single-file-pdf-viewer.test.ts. Every PDF here is
// built by the test (tests/fixtures/pdf.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { sourceForAgent } from "../apps/server/agent-context.ts";
import { config } from "../apps/server/config.ts";
import { revisionMaterial } from "../apps/server/content-moderation.ts";
import { computeCoverFacts } from "../apps/server/covers.ts";
import { db } from "../apps/server/db.ts";
import { PDF_MAX_PAGES, readPdfBounded } from "../apps/server/pdf-reader.ts";
import { isSuspicious } from "../apps/server/phishing-signals.ts";
import { backfillSearch } from "../apps/server/search-backfill.ts";
import { authenticateServiceToken, MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import {
  MIME,
  PDF_MIME,
  SINGLE_FILE_FORMATS,
  isDrawnMime,
  isPdfMime,
  isTextMime,
  mimeForFilename,
  type AgentScope,
} from "../packages/contracts/index.ts";
import { buildPdf } from "./fixtures/pdf.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";

async function call(method: any, url: string, body?: any, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      cookie,
      ...(Buffer.isBuffer(body) ? { "content-type": "application/octet-stream" } : {}),
      ...headers,
    },
    payload: body,
  });
}

/** The web form's three steps; the bytes step answers 422 for a refused file. */
async function upload(filename: string, mime: string, bytes: Buffer, title = filename) {
  const start = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title,
    filename,
    mime,
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(start.statusCode, 200, start.body);
  const uploadId = start.json().uploadId;
  const put = await call("PUT", `/api/uploads/${uploadId}/bytes`, bytes);
  if (put.statusCode !== 200) return { refused: put };
  const finish = await call("POST", `/api/uploads/${uploadId}/finalize`, {});
  assert.equal(finish.statusCode, 200, finish.body);
  return { saved: finish.json() as { artifactId: string; revisionId: string } };
}

async function token(scopes: AgentScope[]) {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'pdf',$5,$6,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(secret), scopes, MCP_AUDIENCE],
  );
  return secret;
}

const publish = (body: unknown, secret: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/publish",
    remoteAddress: `2001:db8::${randomBytes(2).toString("hex")}`,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    payload: JSON.stringify(body),
  });

const revisionOf = async (revisionId: string) =>
  (await db.query("SELECT * FROM revisions WHERE id=$1", [revisionId])).rows[0];

const search = async (q: string) => {
  const response = await call("GET", `/api/artifacts?${new URLSearchParams({ q })}`);
  assert.equal(response.statusCode, 200, response.body);
  return (response.json().items as Array<{ id: string }>).map((item) => item.id);
};

const REPORT = buildPdf({
  pages: [["Quarterly report Zanzibar", "Revenue grew in the third quarter."], ["Second page mentions Kilimanjaro."]],
  title: "Report",
});
/** A look-alike of a bank's sign-in page, as a link annotation of the PDF. */
const PHISHING_URL = "https://sberbank-online.ru-login.xyz/login";

before(async () => {
  owner = await createAccount(`pdf-${randomBytes(5).toString("hex")}`, password);
  const login = await call("POST", "/api/login", { name: owner.name, password });
  assert.equal(login.statusCode, 200, login.body);
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

test("PDF is one row of the format table: binary, its own view, .pdf", () => {
  assert.ok(MIME.includes(PDF_MIME));
  assert.deepEqual(SINGLE_FILE_FORMATS[PDF_MIME], {
    label: "PDF",
    extensions: [".pdf"],
    text: false,
    view: "pdf",
  });
  assert.equal(mimeForFilename("Annual Report.PDF"), PDF_MIME);
  assert.equal(isTextMime(PDF_MIME), false);
  assert.equal(isDrawnMime(PDF_MIME), false);
  assert.equal(isPdfMime(PDF_MIME), true);
});

test("pdf.js in the reader pool reads text, links and scripts, bounded; garbage is invalid", async () => {
  const reading = await readPdfBounded(
    buildPdf({
      pages: [["Hello Zanzibar", "second line"], ["page two"]],
      links: ["https://example.org/a", "mailto:x@example.org"],
      javascript: "app.alert('pwned')",
    }),
  );
  assert.ok(reading.ok);
  assert.equal(reading.pages, 2);
  assert.equal(reading.text, "Hello Zanzibar\nsecond line\n\npage two");
  assert.deepEqual(reading.links, ["https://example.org/a", "mailto:x@example.org"]);
  assert.equal(reading.scripted, true);
  assert.equal(reading.filter.sensitiveInput, false);
  // Only the first PDF_MAX_PAGES pages are read for text.
  const long = await readPdfBounded(
    buildPdf({ pages: Array.from({ length: PDF_MAX_PAGES + 5 }, (_, index) => [`page ${index + 1}`]) }),
  );
  assert.ok(long.ok);
  assert.equal(long.pages, PDF_MAX_PAGES + 5);
  assert.match(long.text, new RegExp(`page ${PDF_MAX_PAGES}$`));
  for (const bytes of [
    Buffer.from("%PDF-1.7\nnot really a pdf"),
    Buffer.from("not a pdf at all"),
    REPORT.subarray(0, 60),
  ])
    assert.deepEqual(await readPdfBounded(bytes), { ok: false, reason: "invalid" });
});

test("a corrupt PDF or another file named .pdf is a clear 422, never a 500", async () => {
  for (const [bytes, message] of [
    [Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF"), /не открывается как PDF/],
    [REPORT.subarray(0, Math.floor(REPORT.length / 3)), /не открывается как PDF/],
    [Buffer.from("<html>not a pdf</html>"), /не соответствует выбранному формату/],
  ] as const) {
    const result = await upload("broken.pdf", PDF_MIME, bytes);
    assert.equal(result.refused?.statusCode, 422, String(result.refused?.body));
    assert.match(result.refused!.json().message, message);
  }
});

test("a PDF's text is searchable on save and through the backfill; the chip says documents", async () => {
  const saved = (await upload("report.pdf", PDF_MIME, REPORT)).saved!;
  const revision = await revisionOf(saved.revisionId);
  assert.equal(revision.mime, PDF_MIME);
  assert.equal(revision.storage_kind, "single");
  assert.equal(revision.manifest, null);
  assert.equal(revision.html_profile, null);
  assert.deepEqual(await search("Zanzibar"), [saved.artifactId]);
  assert.deepEqual(await search("Kilimanjaro"), [saved.artifactId]);
  const documents = await call("GET", "/api/artifacts?kind=documents");
  assert.ok((documents.json().items as Array<{ id: string }>).some((item) => item.id === saved.artifactId));
  await db.query("DELETE FROM artifact_search WHERE artifact_id=$1", [saved.artifactId]);
  assert.deepEqual(await search("Zanzibar"), []);
  const report = await backfillSearch({ artifactIds: [saved.artifactId] });
  assert.equal(report.indexed, 1);
  assert.deepEqual(await search("Zanzibar"), [saved.artifactId]);
});

test("a PDF's link to a look-alike sign-in page is flagged exactly as the same link in a page", async () => {
  const lines = ["Quarterly note", "Account review"];
  const pdf = (await upload("note.pdf", PDF_MIME, buildPdf({ pages: [lines], links: [PHISHING_URL] }), "Note PDF"))
    .saved!;
  const html = (
    await upload(
      "note.html",
      "text/html",
      Buffer.from(
        `<!doctype html><html><head><title>Note</title></head><body>${lines.map((line) => `<p>${line}</p>`).join("")}<a href="${PHISHING_URL}"></a></body></html>`,
      ),
      "Note HTML",
    )
  ).saved!;
  const [pdfRevision, htmlRevision] = await Promise.all([revisionOf(pdf.revisionId), revisionOf(html.revisionId)]);
  assert.ok(pdfRevision.phishing_signals.includes("lookalike:sber"), pdfRevision.phishing_signals.join());
  assert.ok(pdfRevision.phishing_signals.includes("channel:lookalike-login"));
  assert.deepEqual(pdfRevision.phishing_signals, htmlRevision.phishing_signals);
  assert.equal(isSuspicious(pdfRevision.phishing_signals), isSuspicious(htmlRevision.phishing_signals));
  assert.deepEqual(pdfRevision.content_filter.hits.fraud, htmlRevision.content_filter.hits.fraud);
  assert.ok(pdfRevision.content_filter.hits.fraud);
  // The moderator's model reads the text and where the links lead.
  const material = await revisionMaterial(pdfRevision);
  assert.match(material.text, /Quarterly note/);
  assert.match(material.text, /Ссылки в PDF:\nhttps:\/\/sberbank-online\.ru-login\.xyz\/login/);
});

test("a PDF with a /JavaScript OpenAction is saved; the script is read as text, never run", async () => {
  const bytes = buildPdf({ pages: [["Scripted"]], javascript: "app.launchURL('https://example.org/x', true);" });
  const saved = (await upload("scripted.pdf", PDF_MIME, bytes)).saved!;
  const revision = await revisionOf(saved.revisionId);
  assert.equal(revision.mime, PDF_MIME);
  const reading = await readPdfBounded(bytes);
  assert.ok(reading.ok && reading.scripted);
});

test("the cover is a document with the PDF's opening text, no picture", async () => {
  const saved = (await upload("report.pdf", PDF_MIME, REPORT)).saved!;
  const facts = await computeCoverFacts(await revisionOf(saved.revisionId));
  assert.equal(facts.kind, "text");
  assert.equal(facts.genre, "document");
  assert.equal(facts.heading, "Quarterly report Zanzibar");
  assert.match(facts.lead ?? "", /Revenue grew/);
  const cover = await call("GET", `/api/revisions/${saved.revisionId}/cover`);
  assert.equal(cover.statusCode, 200, cover.body);
  assert.equal(cover.json().cover.genre, "document");
  assert.notEqual(cover.json().cover.imageState, "wanted");
});

test("the agent gets source.pdf and its text as source.txt", async () => {
  const saved = (await upload("report.pdf", PDF_MIME, REPORT)).saved!;
  const agent = await authenticateServiceToken(await token(["source:read"]), MCP_AUDIENCE);
  const source = await sourceForAgent(agent, { artifactId: saved.artifactId, revisionId: saved.revisionId });
  const text = "Quarterly report Zanzibar\nRevenue grew in the third quarter.\n\nSecond page mentions Kilimanjaro.\n";
  assert.deepEqual(source.context.availableContent, [
    { path: "source.pdf", mime: PDF_MIME, size: REPORT.length, sha256: sha256(REPORT) },
    { path: "source.txt", mime: "text/plain", size: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) },
  ]);
  assert.deepEqual(
    source.files.map((file) => file.path),
    ["source.pdf", "source.txt"],
  );
  assert.ok(Buffer.from(source.files[0]!.data, "base64").equals(REPORT));
  assert.equal(Buffer.from(source.files[1]!.data, "base64").toString("utf8"), text);
  assert.match(source.context.clipboardText, /source\.txt — текст PDF/);
  // A PDF without text (a scan, say) hands over the PDF alone.
  const empty = buildPdf({ pages: [[]] });
  const blank = (await upload("scan.pdf", PDF_MIME, empty)).saved!;
  const scan = await sourceForAgent(agent, { artifactId: blank.artifactId, revisionId: blank.revisionId });
  assert.deepEqual(
    scan.context.availableContent.map((file) => file.path),
    ["source.pdf"],
  );
});

test("POST /api/v1/publish takes a PDF as kind file in base64, and refuses it as text or broken", async () => {
  const secret = await token(["context", "capture", "revise", "share", "read"]);
  const body = {
    key: randomUUID(),
    title: "Отчёт",
    kind: "file",
    name: "report.pdf",
    base64: REPORT.toString("base64"),
  };
  const first = await publish(body, secret);
  assert.equal(first.statusCode, 200, first.body);
  const result = first.json();
  assert.equal(result.scriptsRunForRecipients, false);
  const revision = await revisionOf(result.revisionId);
  assert.equal(revision.mime, PDF_MIME);
  assert.equal(revision.filename, "report.pdf");
  assert.equal(revision.sha256, sha256(REPORT));
  // Without a viewer domain no link is issued for a PDF; the work is saved.
  assert.equal(config.HTML_LIVE_ENABLED, false);
  assert.equal(result.state, "saved");
  assert.equal(result.url, null);
  assert.match(result.linkUnavailableReason, /PDF открывается на домене просмотра/);
  const again = await publish(body, secret);
  assert.equal(again.json().artifactId, result.artifactId);
  // The format from mime when the name has no extension.
  const named = await publish(
    { key: randomUUID(), title: "x", kind: "file", name: "report", mime: PDF_MIME, base64: REPORT.toString("base64") },
    secret,
  );
  assert.equal(named.statusCode, 200, named.body);
  assert.equal((await revisionOf(named.json().revisionId)).mime, PDF_MIME);
  const asText = await publish(
    { key: randomUUID(), title: "x", kind: "file", name: "a.pdf", text: REPORT.toString("latin1") },
    secret,
  );
  assert.equal(asText.statusCode, 422, asText.body);
  assert.match(asText.json().message, /base64/);
  const broken = await publish(
    {
      key: randomUUID(),
      title: "x",
      kind: "file",
      name: "a.pdf",
      base64: Buffer.from("%PDF-1.7\ngarbage").toString("base64"),
    },
    secret,
  );
  assert.equal(broken.statusCode, 422, broken.body);
  assert.match(broken.json().message, /не открывается как PDF/);
});

test("without a viewer domain: no page, no link; the owner downloads the original as an attachment", async () => {
  assert.equal(config.HTML_LIVE_ENABLED, false);
  const saved = (await upload("report.pdf", PDF_MIME, REPORT)).saved!;
  const view = await call("POST", `/api/revisions/${saved.revisionId}/static-view`, {});
  assert.equal(view.statusCode, 200, view.body);
  // The client sees an app address and shows the card instead of a frame.
  assert.equal(view.json().url, `/api/revisions/${saved.revisionId}/document`);
  assert.equal((await call("GET", view.json().url, undefined, { "sec-fetch-dest": "iframe" })).statusCode, 404);
  const share = await call("POST", `/api/artifacts/${saved.artifactId}/share`, {
    expectedRevisionId: saved.revisionId,
    expiresInDays: 1,
  });
  assert.equal(share.statusCode, 422, share.body);
  assert.match(share.json().message, /PDF открывается на домене просмотра/);
  const bytes = await call("GET", `/api/revisions/${saved.revisionId}/bytes`);
  assert.equal(bytes.statusCode, 200);
  assert.equal(bytes.headers["content-type"], PDF_MIME);
  assert.match(String(bytes.headers["content-disposition"]), /^attachment; filename\*=UTF-8''report\.pdf$/);
  assert.equal(bytes.headers["content-security-policy"], "sandbox; default-src 'none'");
  assert.ok(bytes.rawPayload.equals(REPORT));
});
