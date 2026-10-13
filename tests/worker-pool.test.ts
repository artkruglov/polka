import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { UNREAD, inspectHtmlBounded } from "../apps/server/html.ts";
import { coverFactsBounded } from "../apps/server/covers.ts";
import {
  MARKDOWN_MAX_CHARS,
  markdownCacheStats,
  renderProjectMarkdownBounded,
} from "../apps/server/project-markdown.ts";
import { AWAY_LINK_TTL_SECONDS, verifyAwayToken } from "../apps/server/away-links.ts";
import { workerPoolStats, workerSlots } from "../apps/server/worker-pool.ts";

// The reader pool (apps/server/worker-pool.ts): loaded workers take tasks one
// after another; a task past its deadline costs only its worker.
const page = `<!doctype html><title>Отчёт</title><p>${"Обычный абзац отчёта. ".repeat(900)}</p>`;
const nested = "<div>".repeat(200_000);

test("workers stay loaded and take task after task", async () => {
  await inspectHtmlBounded(page);
  const before = workerPoolStats();
  for (let i = 0; i < 6; i++) {
    const read = await inspectHtmlBounded(page);
    assert.deepEqual({ profile: read.profile, signals: read.signals }, { profile: "static", signals: [] });
  }
  // Cover facts and Markdown go to the same workers.
  const cover = await coverFactsBounded(`<!doctype html><title>Обложка</title><h1>Квартальный отчёт</h1>${page}`);
  assert.equal(cover.heading, "Квартальный отчёт");
  const after = workerPoolStats();
  assert.equal(after.started, before.started, "no new worker for later tasks");
  assert.equal(after.running, 0);
});

test("a task past its deadline is unread, and only its worker is replaced", async () => {
  const before = workerPoolStats();
  const read = await inspectHtmlBounded(nested, 300);
  assert.deepEqual(read, UNREAD);
  const after = workerPoolStats();
  assert.equal(after.retired, before.retired + 1);
  // The next task gets a fresh worker and a normal answer.
  assert.equal((await inspectHtmlBounded(page)).profile, "static");
});

test("tasks past the queue bound are refused with 503 busy", async () => {
  const limit = workerSlots().limit;
  const queue = workerPoolStats().queueLimit;
  workerSlots(1);
  workerPoolStats(1);
  try {
    const running = inspectHtmlBounded(nested, 500);
    const waiting = inspectHtmlBounded(page);
    await assert.rejects(inspectHtmlBounded(page), (error: { status?: number; code?: string; retryAfter?: number }) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "busy");
      assert.equal(error.retryAfter, 5);
      return true;
    });
    assert.deepEqual(await running, UNREAD);
    assert.equal((await waiting).profile, "static");
  } finally {
    workerSlots(limit);
    workerPoolStats(queue);
  }
});

test("drawn Markdown is kept unsigned and its external links are signed when served", async () => {
  const source = `# Ссылки\n\n${"Текст документа. ".repeat(400)}\n\n[Источник](https://example.com/report)\n`;
  const paths = new Set(["README.md"]);
  const first = await renderProjectMarkdownBounded(source, "README.md", paths, "pool-test:away");
  const token = (body: string) => /\/away#([^"]+)"/.exec(body)![1]!;
  assert.equal(verifyAwayToken(token(first.body))?.url, "https://example.com/report");
  // A day later the kept page is served with a link that still opens.
  const later = Date.now() + 2 * AWAY_LINK_TTL_SECONDS * 1000;
  mock.method(Date, "now", () => later);
  try {
    const again = await renderProjectMarkdownBounded(source, "README.md", paths, "pool-test:away");
    assert.doesNotMatch(again.body, /polka-away:/);
    assert.equal(verifyAwayToken(token(again.body), later)?.url, "https://example.com/report");
  } finally {
    mock.restoreAll();
  }
});

test("a document too large to draw is shown as text and not kept", async () => {
  const before = markdownCacheStats();
  const huge = "x".repeat(MARKDOWN_MAX_CHARS + 1);
  const shown = await renderProjectMarkdownBounded(huge, "big.md", new Set(["big.md"]), "pool-test:huge");
  assert.match(shown.body, /показан как текст/);
  assert.deepEqual(markdownCacheStats(), before);
});
