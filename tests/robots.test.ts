// robots.txt matching (RFC 9309): wildcard and end-anchor rules, the longest
// rule wins, and a hostile file cannot hold the process (the pattern was a
// regular expression, and many `*a` parts backtrack without end).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRobots, robotsAllow } from "../packages/robots.ts";

const allowed = (rules: string, path: string) =>
  robotsAllow({ rules: parseRobots(`User-agent: *\n${rules}`) }, new URL(`https://example.com${path}`));

test("prefix, wildcard and end-anchor rules", () => {
  const cases: Array<[string, string, boolean]> = [
    ["Disallow: /private", "/private/a", false],
    ["Disallow: /private", "/public", true],
    ["Disallow: /*.pdf$", "/docs/a.pdf", false],
    ["Disallow: /*.pdf$", "/docs/a.pdf?x=1", true],
    ["Disallow: /*.pdf$", "/docs/a.pdfx", true],
    ["Disallow: /a*b*c", "/aXXbYYc/z", false],
    ["Disallow: /a*b*c", "/aXXcYYb", true],
    ["Disallow: /*", "/anything", false],
    ["Disallow: /*$", "/anything", false],
    ["Disallow: /a$", "/a", false],
    ["Disallow: /a$", "/ab", true],
    ["Disallow: /a*a$", "/a", true],
    ["Disallow: /a*a$", "/aa", false],
    ["Disallow: /a*ab$", "/aab", false],
    ["Disallow: /a*ab$", "/ab", true],
    ["Disallow: /\nAllow: /open", "/open/x", true],
    ["Disallow: /\nAllow: /open", "/closed", false],
    ["Disallow: /x.y", "/xzy", true],
    ["Disallow: /x+y", "/x+y", false],
  ];
  for (const [rules, path, expected] of cases) assert.equal(allowed(rules, path), expected, `${rules} ${path}`);
});

test("a rule of many wildcards is matched in bounded time", () => {
  const hostile = `Disallow: /${"*a".repeat(60)}b`;
  const path = `/${"a".repeat(2000)}`;
  const started = performance.now();
  assert.equal(allowed(hostile, path), true);
  assert.ok(performance.now() - started < 500, "matching did not run away");
});

test("an unparseable robots.txt redirect is no robots.txt, not a crash", async () => {
  const { robotsVia } = await import("../apps/renderer/fetch-page.ts");
  const robots = robotsVia((async () => ({
    status: 301,
    headers: { location: "https://[" },
    body: Buffer.alloc(0),
  })) as any);
  const answer = await robots.get(new URL("https://example.com/page"));
  assert.ok("unreachable" in answer);
});
