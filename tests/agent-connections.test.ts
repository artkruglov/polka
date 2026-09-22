import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, bytes, request } from "../apps/web/src/shared/api/client.ts";
import { classifyIssueError } from "../apps/web/src/pages/agents/index.tsx";

test("request preserves status for empty and JSON error responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("", { status: 401 });
    await assert.rejects(
      request("/agent-connections", undefined, "GET"),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: "forbidden", message: "csrf" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(
      request("/agent-connections", {}, "POST"),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 403 &&
        error.code === "forbidden" &&
        error.message === "csrf",
    );
    globalThis.fetch = async () => new Response("not-json", { status: 200 });
    await assert.rejects(request("/agent-connections", undefined, "GET"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxy error pages and network failures become friendly Russian errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    for (const call of [
      () => request("/me"),
      () => bytes("/revisions/r/bytes"),
    ])
      await assert.rejects(
        call(),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 502 &&
          /временно недоступна/.test(error.message) &&
          !/Unexpected token/.test(error.message),
      );
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(
      request("/me"),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 0 &&
        /Нет связи/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("issue errors distinguish form failures from ambiguous outcomes", () => {
  assert.deepEqual(classifyIssueError(new ApiError(403, "forbidden", "csrf")), {
    kind: "form",
    message: "csrf",
  });
  assert.deepEqual(classifyIssueError(new ApiError(413, "quota", "limit")), {
    kind: "form",
    message: "limit",
  });
  assert.deepEqual(classifyIssueError(new Error("network")), {
    kind: "ambiguous",
  });
});
