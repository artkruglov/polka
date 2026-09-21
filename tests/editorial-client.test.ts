import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  fetchEditorial,
  fetchEditorialItem,
  parseEditorialSlug,
  safeEditorialRecipientUrl,
} from "../apps/web/src/entities/editorial/api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function item(overrides: Record<string, unknown> = {}) {
  return {
    slug: "fractions",
    title: "Доли",
    topic: "Обучение",
    task: "Разобраться с долями.",
    action: "Ответить на вопросы.",
    author: "Редакция Полки",
    license: "Apache-2.0",
    notices: "Оригинальный синтетический материал.",
    publishedAt: "2026-09-21T12:00:00Z",
    recipientUrl: "https://polka.example/s#token",
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("accepts valid local recipient URLs and rejects foreign or malformed URLs", () => {
  assert.equal(
    safeEditorialRecipientUrl("https://app.example/s#token", "https://app.example"),
    "https://app.example/s#token",
  );
  assert.equal(safeEditorialRecipientUrl("https://other.example/s#token", "https://app.example"), null);
  assert.equal(safeEditorialRecipientUrl("https://app.example/s?x=1#token", "https://app.example"), null);
  assert.equal(safeEditorialRecipientUrl("https://app.example/s", "https://app.example"), null);
  assert.equal(safeEditorialRecipientUrl("https://user:pass@app.example/s#token", "https://app.example"), null);
});

test("validates slugs before detail fetch and handles malformed escapes", () => {
  assert.equal(parseEditorialSlug("/discover/fractions"), "fractions");
  assert.equal(parseEditorialSlug("/discover/city-observation"), "city-observation");
  assert.equal(parseEditorialSlug("/discover/Bad"), null);
  assert.equal(parseEditorialSlug("/discover/a%2Fb"), null);
  assert.equal(parseEditorialSlug("/discover/%E0%A4%A"), null);
  assert.equal(parseEditorialSlug("/discover/"), null);
});

test("rejects malformed DTOs, unknown fields and more than twenty list items", async () => {
  globalThis.fetch = async () => response({ items: [item({ unexpected: true })] });
  await assert.rejects(fetchEditorial(), /Не удалось прочитать каталог/);
  globalThis.fetch = async () => response({ items: Array.from({ length: 21 }, () => item()) });
  await assert.rejects(fetchEditorial(), /Не удалось прочитать каталог/);
});

test("returns null for detail 404 and hides malformed detail errors", async () => {
  globalThis.fetch = async () => response({ message: "missing" }, 404);
  assert.equal(await fetchEditorialItem("missing"), null);
  globalThis.fetch = async () => response({ ...item(), unexpected: true });
  await assert.rejects(fetchEditorialItem("fractions"), /Не удалось прочитать материал/);
});

test("passes abort signal through list fetch", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | null | undefined;
  globalThis.fetch = (_input, init) => {
    seen = init?.signal;
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  };
  await assert.rejects(fetchEditorial(controller.signal), (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(seen, controller.signal);
});
