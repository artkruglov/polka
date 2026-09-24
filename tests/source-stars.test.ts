// GET /api/source/stars: the GitHub star count of SOURCE_URL, fetched by the
// server (the browser may not talk to GitHub), cached for an hour, null for
// anything that is not a plain github.com/<owner>/<repo> or when GitHub does
// not answer. Fetch is mocked throughout; nothing here touches the network.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { createApp, sourceStars } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  STARS_RETRY_MS,
  STARS_TTL_MS,
  createStarCounter,
  githubRepository,
} from "../apps/server/source-stars.ts";
import { s3 } from "../apps/server/storage.ts";
import {
  MIN_STARS_SHOWN,
  formatStars,
  selfHostGuideUrl,
} from "../apps/web/src/shared/lib/project-links.ts";

const app = await createApp();
const originalFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = originalFetch;
  sourceStars.reset();
  await app.close();
  await db.end();
  s3.destroy();
});

const github = (stars: unknown, status = 200) =>
  new Response(JSON.stringify({ stargazers_count: stars }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A fetch that answers from the queue and records every call. */
function fakeFetch(answers: (() => Promise<Response>)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = answers.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test("githubRepository: only https://github.com/<owner>/<repo>", () => {
  assert.deepEqual(githubRepository("https://github.com/artkruglov/polka"), {
    owner: "artkruglov",
    repo: "polka",
  });
  assert.deepEqual(githubRepository("https://github.com/Org-1/my.repo/"), {
    owner: "Org-1",
    repo: "my.repo",
  });
  assert.deepEqual(githubRepository("https://github.com/o/r.git"), {
    owner: "o",
    repo: "r",
  });
  for (const other of [
    "https://git.example.org/team/polka",
    "https://gitlab.com/team/polka",
    "https://github.com/artkruglov",
    "https://github.com/artkruglov/polka/tree/main",
    "https://github.com/artkruglov/polka?tab=stars",
    "https://github.com/artkruglov/polka#readme",
    "https://github.com/../polka",
    "https://github.com/a.b/polka",
    "http://github.com/artkruglov/polka",
    "https://www.github.com/artkruglov/polka",
    "not a url",
  ])
    assert.equal(githubRepository(other), null, other);
});

test("counter: one request, cached for an hour, then asked again", async () => {
  let clock = 1_000_000;
  const { fetch, calls } = fakeFetch([
    async () => github(1234),
    async () => github(1300),
  ]);
  const counter = createStarCounter({
    sourceUrl: "https://github.com/artkruglov/polka",
    fetch,
    now: () => clock,
  });
  assert.equal(await counter.stars(), 1234);
  assert.equal(await counter.stars(), 1234);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/artkruglov/polka");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.accept, "application/vnd.github+json");
  assert.match(headers["user-agent"], /polka/);
  assert.ok(calls[0].init?.signal instanceof AbortSignal, "a timeout");
  assert.equal(calls[0].init?.redirect, "manual");
  clock += STARS_TTL_MS - 1;
  assert.equal(await counter.stars(), 1234);
  assert.equal(calls.length, 1);
  clock += 2;
  assert.equal(await counter.stars(), 1300);
  assert.equal(calls.length, 2);
});

test("counter: concurrent callers share one request", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { fetch, calls } = fakeFetch([
    async () => {
      await gate;
      return github(42);
    },
  ]);
  const counter = createStarCounter({
    sourceUrl: "https://github.com/o/r",
    fetch,
  });
  const first = counter.stars();
  const second = counter.stars();
  release();
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.equal(calls.length, 1);
});

test("counter: a failure is null and GitHub is left alone for a few minutes", async () => {
  let clock = 5_000_000;
  const { fetch, calls } = fakeFetch([
    async () => github(0, 403), // rate limited
    async () => github(77),
  ]);
  const counter = createStarCounter({
    sourceUrl: "https://github.com/o/r",
    fetch,
    now: () => clock,
  });
  assert.equal(await counter.stars(), null);
  assert.equal(await counter.stars(), null);
  assert.equal(calls.length, 1);
  clock += STARS_RETRY_MS + 1;
  assert.equal(await counter.stars(), 77);
  assert.equal(calls.length, 2);
});

test("counter: unreachable, slow or odd answers are null, never errors", async () => {
  for (const answer of [
    async () => {
      throw new Error("ECONNRESET");
    },
    async () => {
      throw new DOMException("aborted", "TimeoutError");
    },
    async () => new Response("<html>", { status: 200 }),
    async () => github("1234"),
    async () => github(-1),
    async () => github(1.5),
    async () => new Response(JSON.stringify({}), { status: 200 }),
    async () =>
      new Response("", {
        status: 301,
        headers: { location: "https://api.github.com/repos/o/moved" },
      }),
  ]) {
    const counter = createStarCounter({
      sourceUrl: "https://github.com/o/r",
      fetch: fakeFetch([answer]).fetch,
    });
    assert.equal(await counter.stars(), null);
  }
});

test("counter: a source outside GitHub never asks anyone", async () => {
  const { fetch, calls } = fakeFetch([]);
  const counter = createStarCounter({
    sourceUrl: "https://git.example.org/team/polka",
    fetch,
  });
  assert.equal(counter.repository, null);
  assert.equal(await counter.stars(), null);
  assert.equal(calls.length, 0);
});

test("GET /api/source/stars answers { stars } from the cache, cacheable by the browser", async () => {
  assert.equal(config.SOURCE_URL, "https://github.com/artkruglov/polka");
  sourceStars.reset();
  let requests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests++;
    assert.equal(
      String(input),
      "https://api.github.com/repos/artkruglov/polka",
    );
    return github(256);
  }) as typeof globalThis.fetch;
  try {
    const first = await app.inject({ method: "GET", url: "/api/source/stars" });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { stars: 256 });
    assert.equal(first.headers["cache-control"], "public, max-age=600");
    const second = await app.inject({
      method: "GET",
      url: "/api/source/stars",
    });
    assert.deepEqual(second.json(), { stars: 256 });
    assert.equal(requests, 1);

    sourceStars.reset();
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof globalThis.fetch;
    const offline = await app.inject({
      method: "GET",
      url: "/api/source/stars",
    });
    assert.equal(offline.statusCode, 200);
    assert.deepEqual(offline.json(), { stars: null });
  } finally {
    globalThis.fetch = originalFetch;
    sourceStars.reset();
  }
});

test("the interface shows a count only from 10 stars, in short form", () => {
  assert.equal(MIN_STARS_SHOWN, 10);
  assert.equal(formatStars(null), null);
  assert.equal(formatStars(0), null);
  assert.equal(formatStars(9), null);
  assert.equal(formatStars(10), "10");
  assert.equal(formatStars(999), "999");
  // Intl keeps the number and the unit together with a no-break space.
  const plain = (value: string | null) => value?.replace(/ /g, " ");
  assert.equal(plain(formatStars(1000)), "1 тыс.");
  assert.equal(plain(formatStars(1234)), "1,2 тыс.");
  assert.equal(plain(formatStars(12_345)), "12,3 тыс.");
  assert.equal(plain(formatStars(1_234_567)), "1,2 млн");
  // The self-host path: the hosted guide on GitHub, or a fork's own source page.
  assert.equal(
    selfHostGuideUrl("https://github.com/artkruglov/polka"),
    "https://github.com/artkruglov/polka/blob/main/deploy/hosted/README.md",
  );
  assert.equal(
    selfHostGuideUrl("https://git.example.org/team/polka"),
    "https://git.example.org/team/polka",
  );
  // The header offers the source on every page; the landing has the self-host section.
  const navigation = readFileSync(
    "apps/web/src/widgets/navigation/index.tsx",
    "utf8",
  );
  assert.match(navigation, /useSourceStars\(\)/);
  assert.match(navigation, /<GitHubMark/);
  const landing = readFileSync("apps/web/src/pages/landing/index.tsx", "utf8");
  assert.match(landing, /Подключить агента/);
  assert.match(landing, /Развернуть у себя/);
  assert.match(landing, /href="\/enterprise"/);
  assert.match(landing, /docker compose/);
});
