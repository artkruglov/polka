// Rendered import (apps/server/url-import/rendered.ts): robots.txt rules for
// PolkaRenderer, the renderer's answer turned into a script-free bundle with
// the snapshot provenance and warning, a Claude artifact's frame, failures
// mapped without retries, the job's «rendering» state, and the content filter
// on the saved snapshot. The renderer and the page's resources are stand-ins.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createAccount } from "../apps/server/auth.ts";
import { db } from "../apps/server/db.ts";
import { s3 } from "../apps/server/storage.ts";
import { captureForOwner, validateAgentCapture } from "../apps/server/agent-capture.ts";
import { parseRobots, robotsAllow, robotsFor, clearRobotsCache } from "../apps/server/url-import/robots.ts";
import { captureRendered, SNAPSHOT_WARNING } from "../apps/server/url-import/rendered.ts";
import { parseRenderAnswer } from "../apps/server/url-import/renderer-client.ts";
import { rendererUrlAllowed } from "../apps/server/url-import/renderer-url.ts";
import { prepareImport } from "../apps/server/url-import/prepare.ts";
import { ImportFetchError } from "../apps/server/url-import/public-fetch.ts";
import { runImportOnce } from "../apps/server/url-import/worker.ts";
import { createImportJob, getImportJob } from "../apps/server/url-import/jobs.ts";
import type { RenderResult } from "../packages/renderer-contract.ts";

after(async () => {
  await db.end();
  s3.destroy();
});

const PAGE = "https://demo.lovable.app/";
const snapshot = (html: string, over: Partial<{ finalUrl: string; title: string }> = {}): RenderResult => ({
  finalUrl: PAGE,
  title: "Demo app",
  html,
  frames: [],
  ...over,
});
const assets = async (url: string) => {
  if (url === "https://demo.lovable.app/assets/index.css")
    return { url, contentType: "text/css", bytes: Buffer.from("h1{color:teal}") };
  throw Error(`unexpected ${url}`);
};

test("robots.txt: our group or «*», longest match, Allow wins ties, wildcards and $", () => {
  const text = `
User-agent: GPTBot
Disallow: /

User-agent: *
Disallow: /private/
Allow: /private/open$
Disallow: /*.json$

User-agent: PolkaRenderer
User-agent: other
Disallow: /app/
Allow: /app/public
`;
  const ours = { rules: parseRobots(text) };
  assert.equal(robotsAllow(ours, new URL("https://x.test/app/secret")), false);
  assert.equal(robotsAllow(ours, new URL("https://x.test/app/public/page")), true);
  // Our own group replaces «*»: /private/ is not ours to obey.
  assert.equal(robotsAllow(ours, new URL("https://x.test/private/a")), true);
  const star = { rules: parseRobots(text, "someoneelse") };
  assert.equal(robotsAllow(star, new URL("https://x.test/private/a")), false);
  assert.equal(robotsAllow(star, new URL("https://x.test/private/open")), true);
  assert.equal(robotsAllow(star, new URL("https://x.test/private/open/more")), false);
  assert.equal(robotsAllow(star, new URL("https://x.test/data.json")), false);
  assert.equal(robotsAllow(star, new URL("https://x.test/data.json?x=1")), true);
  assert.equal(robotsAllow({ rules: parseRobots("User-agent: *\nDisallow: /") }, new URL("https://x.test/")), false);
  assert.equal(robotsAllow({ rules: parseRobots("User-agent: *\nDisallow:") }, new URL("https://x.test/a")), true);
  assert.equal(robotsAllow({ unreachable: true }, new URL("https://x.test/")), false);
});

test("robots.txt is fetched once per host per hour; 404 allows, 5xx disallows", async () => {
  clearRobotsCache();
  let calls = 0;
  const now = Date.UTC(2026, 8, 24);
  const fetcher = async (url: string) => {
    calls++;
    return { url, contentType: "text/plain", bytes: Buffer.from("User-agent: *\nDisallow: /x") };
  };
  const origin = new URL("https://cache.github.io/");
  await robotsFor(origin, { fetcher, now });
  await robotsFor(origin, { fetcher, now: now + 59 * 60_000 });
  assert.equal(calls, 1);
  await robotsFor(origin, { fetcher, now: now + 61 * 60_000 });
  assert.equal(calls, 2);
  const failing = (status: number) => async () => {
    throw new ImportFetchError("source_unavailable", "x", { status, headers: {} });
  };
  assert.deepEqual(await robotsFor(new URL("https://none.github.io/"), { fetcher: failing(404), now }), { rules: [] });
  assert.deepEqual(await robotsFor(new URL("https://down.github.io/"), { fetcher: failing(503), now }), { unreachable: true });
});

test("a rendered page becomes a script-free snapshot bundle with provenance and a warning", async () => {
  let rendering = 0;
  const result = await captureRendered(PAGE, {
    onRendering: async () => void rendering++,
    render: async () =>
      snapshot(
        '<!doctype html><html><head><title>x</title><link rel="stylesheet" href="/assets/index.css"><script type="module" src="/assets/index.js"></script></head>' +
          '<body><div id="root"><h1 onclick="steal()">Rendered</h1><a href="javascript:alert(1)">x</a></div><noscript>Enable JS</noscript><script>window.x=1</script></body></html>',
      ),
    fetcher: assets,
  });
  assert.equal(rendering, 1);
  assert.equal(result.title, "Demo app");
  assert.equal(result.manifest.provenance.renderer, "headless-snapshot-v1");
  assert.equal(result.manifest.provenance.sourceUrl, PAGE);
  assert.ok(result.warnings.includes(SNAPSHOT_WARNING));
  assert.equal(result.previewReady, true, JSON.stringify(result.warnings));
  const parsed = validateAgentCapture(
    { key: randomUUID(), title: result.title, manifest: result.manifest, files: result.files },
    "capture",
  );
  const html = parsed.source.get("index.html")!.toString();
  assert.match(html, /Rendered/);
  for (const gone of [/<script/i, /<noscript/i, /onclick/i, /javascript:/i]) assert.doesNotMatch(html, gone);
  assert.ok([...parsed.source.values()].some((bytes) => bytes.toString() === "h1{color:teal}"), "CSS localised");
});

test("the renderer's refusals stop an import; nothing is retried", async () => {
  let renders = 0;
  const answer = (result: RenderResult) => async () => {
    renders++;
    return result;
  };
  // robots.txt is read by the renderer, from the machine that opens the page.
  await assert.rejects(captureRendered(PAGE, { render: answer({ error: "robots_disallowed" }) }), { code: "robots_disallowed" });
  await assert.rejects(captureRendered(PAGE, { render: answer({ error: "robots_unavailable" }) }), { code: "robots_unavailable" });
  await assert.rejects(captureRendered(PAGE, { render: answer({ error: "source_blocked", detail: "cloudflare_challenge" }) }), {
    code: "source_blocked",
  });
  assert.equal(renders, 3, "one request each");
  await assert.rejects(captureRendered("https://example.com/", { render: answer(snapshot("<h1>x</h1>")) }), { code: "not_allowed" });
  assert.equal(renders, 3, "a host outside the allowlist is never sent to the renderer");
  await assert.rejects(
    captureRendered(PAGE, { render: async () => snapshot("<h1>x</h1>", { finalUrl: "https://evil.example/" }) }),
    { code: "not_allowed" },
  );
  await assert.rejects(
    captureRendered(PAGE, {
      render: async () => {
        throw Error("ECONNREFUSED");
      },
    }),
    { code: "renderer_unavailable" },
  );
});

test("a Claude artifact: one try; its frame is the snapshot, a challenge is source_blocked", async () => {
  const ARTIFACT = "https://claude.ai/artifact/F49sUXozTkEFzFawwHGSxo";
  let calls = 0;
  const result = await captureRendered(ARTIFACT, {
    render: async () => {
      calls++;
      return {
        finalUrl: ARTIFACT,
        title: "Budget planner | Claude",
        html: "<!doctype html><title>Claude</title><div id=app>chat app shell</div>",
        frames: [
          { url: "https://www.claudeusercontent.com/artifact/x", html: "<html><body><iframe srcdoc></iframe></body></html>" },
          { url: "about:srcdoc", html: "<!doctype html><html><head><title>Planner</title></head><body><h1>Budget planner</h1><p>Income and expenses per month.</p><script>calc()</script></body></html>" },
        ],
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.title, "Budget planner");
  const html = Buffer.from(result.files.find((f) => f.path === "index.html")!.data, "base64").toString();
  assert.match(html, /Budget planner/);
  assert.doesNotMatch(html, /chat app shell/);
  assert.doesNotMatch(html, /<script/);
  assert.equal(result.manifest.provenance.sourceUrl, ARTIFACT);
  // No artifact frame (Cloudflare, or the chat app without the artifact): source_blocked.
  await assert.rejects(
    captureRendered(ARTIFACT, { render: async () => ({ finalUrl: ARTIFACT, title: "Claude", html: "<div>app</div>", frames: [] }) }),
    { code: "source_blocked" },
  );
  await assert.rejects(captureRendered(ARTIFACT, { render: async () => ({ error: "source_blocked", detail: "cloudflare_turnstile" }) }), {
    code: "source_blocked",
  });
});

test("the import dispatcher sends allowlisted SPA hosts to the renderer only when it is enabled", async () => {
  let used = 0;
  const rendered = { render: async () => (used++, snapshot("<h1>ok</h1>")) };
  await prepareImport(PAGE, { renderedEnabled: true, rendered });
  assert.equal(used, 1);
  await assert.rejects(prepareImport("https://gemini.google.com/share/abc123", { renderedEnabled: false, rendered }), {
    code: "renderer_disabled",
  });
  await assert.rejects(prepareImport("https://claude.ai/share/0b5c2f0e-1111-4222-8333-444455556666", { renderedEnabled: true, rendered }), {
    code: "provider_adapter_required",
  });
  assert.equal(used, 1);
});

test("renderer answers are checked; RENDERER_URL must be https outside loopback and docker", () => {
  assert.throws(() => parseRenderAnswer(200, "<html>"));
  assert.throws(() => parseRenderAnswer(200, JSON.stringify({ html: 1 })));
  assert.throws(() => parseRenderAnswer(422, JSON.stringify({ error: "weird" })));
  assert.deepEqual(parseRenderAnswer(422, JSON.stringify({ error: "source_blocked", detail: "x" })), {
    error: "source_blocked",
    detail: "x",
  });
  const big = "x".repeat(5 * 1024 * 1024 + 1);
  assert.deepEqual(parseRenderAnswer(200, JSON.stringify({ finalUrl: PAGE, title: "", html: big, frames: [] })), {
    error: "too_large",
  });
  for (const url of ["https://renderer.example.com", "http://127.0.0.1:4395", "http://localhost:4395", "http://renderer:4395", "http://172.29.0.2:4395"])
    assert.equal(rendererUrlAllowed(url), true, url);
  for (const url of ["http://renderer.example.com", "http://10.0.0.5:4395", "http://8.8.8.8", "ftp://renderer", "https://u:p@renderer.example.com"])
    assert.equal(rendererUrlAllowed(url), false, url);
});

test("the job shows «rendering» while the renderer works", async () => {
  const owner = await createAccount("render-" + randomBytes(5).toString("hex"), randomBytes(24).toString("hex"));
  const c = await db.connect();
  const schema = "test_render_" + randomBytes(8).toString("hex");
  try {
    await c.query("BEGIN");
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET LOCAL search_path TO ${schema},public`);
    for (const file of ["019_url_import_jobs.sql", "037_url_import_rendering.sql"])
      await c.query(await readFile(new URL(`../deploy/migrations/${file}`, import.meta.url), "utf8"));
    const job = await createImportJob(c, owner, { key: randomUUID(), url: PAGE });
    const run = <T>(fn: (client: typeof c) => Promise<T>) => fn(c);
    const seen: string[] = [];
    await runImportOnce({
      run,
      prepare: (url, options) =>
        prepareImport(url, {
          ...options,
          renderedEnabled: true,
          rendered: {
            render: async () => {
              seen.push((await getImportJob(c, owner, job.id)).state);
              return snapshot("<h1>Rendered</h1>");
            },
          },
        }),
      persist: async () => ({ ok: true }),
    });
    assert.deepEqual(seen, ["rendering"]);
    const stored = await getImportJob(c, owner, job.id);
    assert.deepEqual(stored.warnings, [SNAPSHOT_WARNING]);
    const failed = await createImportJob(c, owner, { key: randomUUID(), url: "https://blocked.github.io/" });
    await runImportOnce({
      run,
      prepare: (url, options) =>
        prepareImport(url, {
          ...options,
          renderedEnabled: true,
          rendered: { render: async () => ({ error: "source_blocked" }) },
        }),
      persist: async () => ({ ok: true }),
    });
    const blocked = await getImportJob(c, owner, failed.id);
    assert.equal(blocked.state, "failed");
    assert.equal(blocked.error_code, "source_blocked");
    assert.equal(blocked.attempts, 1);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});

test("a rendered snapshot is saved through the same content filter as any import", async () => {
  const owner = await createAccount("render-save-" + randomBytes(5).toString("hex"), randomBytes(24).toString("hex"));
  const result = await captureRendered(PAGE, {
    render: async () =>
      snapshot(
        "<!doctype html><title>Casino</title><main><h1>Онлайн казино Вулкан</h1><p>Онлайн казино Вулкан: фриспины за регистрацию, бонус на депозит, рабочее зеркало. Играть на деньги!</p></main>",
      ),
  });
  const receipt = (await captureForOwner(owner, {
    key: randomUUID(),
    title: result.title,
    manifest: result.manifest,
    files: result.files,
  })) as { revisionId: string };
  const {
    rows: [revision],
  } = await db.query("SELECT manifest,content_filter FROM revisions WHERE id=$1", [receipt.revisionId]);
  assert.equal(revision.manifest.provenance.renderer, "headless-snapshot-v1");
  assert.ok(revision.content_filter.hits?.gambling, JSON.stringify(revision.content_filter));
});
