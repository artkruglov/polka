// Gist import through GitHub's REST API (apps/server/url-import/gist.ts): which
// links are gists, an HTML file with its own CSS as a page, code-only gists as
// a readable static page, and GitHub's rate limit reported without a retry.
// The API is a stand-in: no request leaves the test.
import test from "node:test";
import assert from "node:assert/strict";
import { captureGist, gistTarget, type GistFetcher } from "../apps/server/url-import/gist.ts";
import { ImportFetchError } from "../apps/server/url-import/public-fetch.ts";
import { validateAgentCapture } from "../apps/server/agent-capture.ts";

const ID = "aa5a315d61ae9438b18d";
const api = `https://api.github.com/gists/${ID}`;
function github(
  gist: unknown,
  requests: Array<{ url: string; accept?: string; authorization?: string }> = [],
  extra: Record<string, [string, string]> = {},
): GistFetcher {
  return async (url, options) => {
    requests.push({ url, accept: options.accept, authorization: options.authorization });
    if (url === api)
      return { url, contentType: "application/json", bytes: Buffer.from(JSON.stringify(gist)) };
    const entry = extra[url];
    if (entry) return { url, contentType: entry[0], bytes: Buffer.from(entry[1]) };
    throw Error(`unexpected request ${url}`);
  };
}
const file = (filename: string, content: string) => ({
  filename,
  size: content.length,
  truncated: false,
  content,
});

test("gist links: gist.github.com pages and gistpreview, nothing else", () => {
  assert.deepEqual(gistTarget(`https://gist.github.com/octocat/${ID}`), { id: ID, file: null });
  assert.deepEqual(gistTarget(`https://gist.github.com/${ID}`), { id: ID, file: null });
  assert.deepEqual(gistTarget(`https://gist.github.com/octocat/${ID}/0a1b2c3d`), { id: ID, file: null });
  assert.deepEqual(gistTarget(`https://gistpreview.github.io/?${ID}/demo.html`), { id: ID, file: "demo.html" });
  assert.deepEqual(gistTarget(`https://gistpreview.github.io/?${ID}`), { id: ID, file: null });
  for (const url of [
    "http://gist.github.com/octocat/" + ID,
    "https://gist.github.com/octocat",
    "https://gist.github.com/octocat/not-an-id",
    "https://github.com/octocat/" + ID,
    "https://gistpreview.github.io/",
    "https://example.github.io/?" + ID,
  ])
    assert.equal(gistTarget(url), null, url);
});

test("an HTML gist becomes the page, its own CSS comes from the API answer", async () => {
  const requests: Array<{ url: string; accept?: string; authorization?: string }> = [];
  const result = await captureGist(`https://gistpreview.github.io/?${ID}/demo.html`, {
    fetcher: github(
      {
        id: ID,
        description: "Calculator demo",
        owner: { login: "octocat" },
        files: {
          "README.md": file("README.md", "# notes"),
          "demo.html": file(
            "demo.html",
            '<!doctype html><link rel="stylesheet" href="style.css"><h1>Demo</h1><img src="https://cdn.example.org/logo.svg">',
          ),
          "style.css": file("style.css", "h1{color:teal}"),
        },
      },
      requests,
      {
        "https://cdn.example.org/logo.svg": [
          "image/svg+xml",
          '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
        ],
      },
    ),
  });
  // One API request (JSON accept, no token in this environment), then only the external image.
  assert.equal(requests[0].url, api);
  assert.equal(requests[0].accept, "application/vnd.github+json");
  assert.deepEqual(
    requests.map((r) => r.url),
    [api, "https://cdn.example.org/logo.svg"],
  );
  assert.equal(result.title, "Calculator demo");
  assert.equal(result.manifest.provenance.sourceUrl, `https://gist.github.com/octocat/${ID}`);
  assert.equal(result.files.length, 3);
  const parsed = validateAgentCapture(
    { key: "12345678-1234-4234-8234-123456789012", title: result.title, manifest: result.manifest, files: result.files },
    "capture",
  );
  const css = [...parsed.source.entries()].find(([, bytes]) => bytes.toString().includes("teal"));
  assert.ok(css, "the gist's CSS is part of the bundle");
});

test("a gist without HTML is a static page of its files as code", async () => {
  const result = await captureGist(`https://gist.github.com/octocat/${ID}`, {
    fetcher: github({
      id: ID,
      description: "",
      owner: { login: "octocat" },
      files: {
        "solve.py": file("solve.py", "print('<b>hi</b>')"),
        "data.json": file("data.json", '{"a":1}'),
      },
    }),
  });
  assert.equal(result.title, "solve.py");
  assert.equal(result.files.length, 1);
  const html = Buffer.from(result.files[0].data, "base64").toString();
  assert.match(html, /&lt;b&gt;hi&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.equal(result.previewReady, true, JSON.stringify(result.warnings));
});

test("GitHub's rate limit and a missing gist are reported, never retried", async () => {
  let calls = 0;
  const limited: GistFetcher = async () => {
    calls++;
    throw new ImportFetchError("source_unavailable", "HTTP 403", {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
      },
    });
  };
  await assert.rejects(captureGist(`https://gist.github.com/octocat/${ID}`, { fetcher: limited }), (error: any) => {
    assert.equal(error.code, "rate_limited");
    assert.match(error.message, /через 10 мин/);
    return true;
  });
  assert.equal(calls, 1);
  const secondary: GistFetcher = async () => {
    throw new ImportFetchError("source_unavailable", "HTTP 429", { status: 429, headers: { "retry-after": "120" } });
  };
  await assert.rejects(captureGist(`https://gist.github.com/${ID}`, { fetcher: secondary }), {
    code: "rate_limited",
  });
  const missing: GistFetcher = async () => {
    throw new ImportFetchError("source_unavailable", "HTTP 404", { status: 404, headers: {} });
  };
  await assert.rejects(captureGist(`https://gist.github.com/${ID}`, { fetcher: missing }), {
    code: "source_unavailable",
  });
  await assert.rejects(
    captureGist(`https://gist.github.com/${ID}`, {
      fetcher: github({ id: ID, files: { "big.html": { filename: "big.html", size: 2e6, truncated: true, content: "" } } }),
    }),
    { code: "too_large" },
  );
});

test("an Authorization header never follows a redirect to another host", async () => {
  const { hopHeaders } = await import("../apps/server/url-import/public-fetch.ts");
  const first = "https://api.github.com/gists/x";
  const options = { accept: "application/vnd.github+json", authorization: "Bearer test" };
  assert.equal(hopHeaders(first, new URL(first), options).Authorization, "Bearer test");
  assert.equal(hopHeaders(first, new URL("https://evil.example/x"), options).Authorization, undefined);
  assert.equal(hopHeaders(first, new URL("https://api.github.com.evil.example/"), options).Authorization, undefined);
  assert.equal(hopHeaders(first, new URL(first), {}).Accept.startsWith("text/html"), true);
});
