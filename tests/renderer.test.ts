// The renderer's pieces that need no browser (apps/renderer): the challenge
// detector, the request signature, and the egress proxy's decisions, including
// a real CONNECT through it. The browser and Docker runs are in
// scripts/test-renderer-runtime.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { gzipSync } from "node:zlib";
import { detectChallenge } from "../apps/renderer/challenge.ts";
import { createEgressProxy, egressTarget } from "../apps/renderer/egress-proxy.ts";
import { TITLE_SCAN_CHARS, fetchPage, readTitle, robotsVia } from "../apps/renderer/fetch-page.ts";
import { FetchFailure, proxiedGet, type ProxiedAnswer, type ProxiedGet } from "../apps/renderer/proxied-fetch.ts";
import { RENDERER_USER_AGENT, signRenderRequest, verifyRenderRequest } from "../packages/renderer-contract.ts";

const page = (over: Partial<Parameters<typeof detectChallenge>[0]> = {}) => ({
  url: "https://demo.lovable.app/",
  title: "Demo",
  headers: {},
  status: 200,
  frameUrls: ["https://demo.lovable.app/"],
  text: "x".repeat(500),
  ...over,
});

test("challenge detector: Cloudflare, Turnstile, captcha and consent walls are source_blocked", () => {
  assert.equal(detectChallenge(page()), null);
  assert.equal(detectChallenge(page({ title: "Just a moment..." })), "cloudflare_challenge");
  assert.equal(detectChallenge(page({ headers: { "cf-mitigated": "challenge" } })), "cloudflare_challenge");
  assert.equal(
    detectChallenge(
      page({
        frameUrls: ["https://demo.lovable.app/", "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x"],
      }),
    ),
    "cloudflare_turnstile",
  );
  assert.equal(
    detectChallenge(page({ frameUrls: ["https://www.google.com/recaptcha/api2/anchor"], text: "verify" })),
    "captcha",
  );
  assert.equal(detectChallenge(page({ url: "https://consent.google.com/ml?continue=x" })), "consent_wall");
  // Gemini: the banner covers the page but the conversation is in the DOM — kept, nothing clicked.
  assert.equal(
    detectChallenge(page({ url: "https://gemini.google.com/share/abc", title: "Before you continue to Google" })),
    null,
  );
  assert.equal(
    detectChallenge(
      page({
        url: "https://gemini.google.com/share/abc",
        title: "Before you continue to Google",
        text: "Accept all Reject all",
      }),
    ),
    "consent_wall",
  );
  assert.equal(detectChallenge(page({ status: 403, text: "Forbidden" })), "http_403");
  assert.equal(detectChallenge(page({ status: 403 })), null, "a 403 with real content is left to the caller");
});

test("a fetched page's title is read from its top in linear time", () => {
  assert.equal(readTitle("<html><head><TITLE lang=en>Just a moment...</TITLE>"), "Just a moment...");
  assert.equal(readTitle("<titles>x</titles><title>y</title>"), "y");
  assert.equal(readTitle("<title>" + "x".repeat(301) + "</title>"), "");
  assert.equal(readTitle(" ".repeat(TITLE_SCAN_CHARS) + "<title>late</title>"), "");
  for (const shape of [(n: number) => "<title x".repeat(n / 8), (n: number) => "<title>".repeat(n / 7)]) {
    const time = (size: number) => {
      const html = shape(size);
      const started = performance.now();
      for (let round = 0; round < 5; round++) readTitle(html);
      return performance.now() - started;
    };
    const small = time(8 * 1024);
    const large = time(32 * 1024);
    const huge = time(4 * 1024 * 1024);
    assert.ok(large < 200 && huge < 400, `${small.toFixed(1)} / ${large.toFixed(1)} / ${huge.toFixed(1)} ms`);
    assert.ok(large / Math.max(small, 2) < 10, `${small.toFixed(1)} ms -> ${large.toFixed(1)} ms`);
  }
});

test("render requests are signed over time, method, path and body; 60 s of skew", () => {
  const secret = "s".repeat(40);
  const body = JSON.stringify({ url: "https://demo.lovable.app/" });
  const now = Date.UTC(2026, 8, 24, 12);
  const headers = signRenderRequest(secret, "POST", "/render", body, now);
  assert.equal(verifyRenderRequest(secret, headers, "POST", "/render", body, now), true);
  assert.equal(verifyRenderRequest(secret, headers, "POST", "/render", body, now + 59_000), true);
  assert.equal(verifyRenderRequest(secret, headers, "POST", "/render", body, now + 61_000), false);
  assert.equal(verifyRenderRequest(secret, headers, "POST", "/render", body, now - 61_000), false);
  assert.equal(verifyRenderRequest(secret, headers, "POST", "/render", body.replace("demo", "evil"), now), false);
  assert.equal(verifyRenderRequest(secret, headers, "POST", "/other", body, now), false);
  assert.equal(verifyRenderRequest("t".repeat(40), headers, "POST", "/render", body, now), false);
  assert.equal(verifyRenderRequest(secret, {}, "POST", "/render", body, now), false);
  assert.equal(
    verifyRenderRequest(secret, { ...headers, "x-polka-signature": "zz" }, "POST", "/render", body, now),
    false,
  );
  assert.equal(RENDERER_USER_AGENT, "PolkaRenderer/1.0 (+https://polochka.app/bot)");
});

test("egress decisions: metadata, loopback, private, docker and mixed DNS answers are refused", async () => {
  const resolver = (answers: Record<string, string[]>) => async (host: string) =>
    (answers[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  const dns = resolver({
    "public.example": ["93.184.215.14"],
    "rebind.example": ["93.184.215.14", "127.0.0.1"],
    "docker.example": ["172.17.0.1"],
    "ula.example": ["fd00::1"],
    "metadata.example": ["169.254.169.254"],
  });
  assert.deepEqual(await egressTarget("public.example:443", { resolver: dns }), {
    address: "93.184.215.14",
    port: 443,
    host: "public.example",
  });
  for (const authority of [
    "169.254.169.254:443",
    "metadata.example:443",
    "127.0.0.1:443",
    "[::1]:443",
    "10.0.0.5:443",
    "172.17.0.1:443",
    "172.29.0.1:443",
    "192.168.1.1:443",
    "100.100.100.200:443",
    "docker.example:443",
    "rebind.example:443",
    "ula.example:443",
    "[fe80::1]:443",
    "[::ffff:127.0.0.1]:443",
    "nothing.example:443",
  ])
    assert.ok("refused" in (await egressTarget(authority, { resolver: dns })), authority);
  assert.deepEqual(await egressTarget("public.example:80", { resolver: dns }), { refused: "port" });
  assert.deepEqual(await egressTarget("public.example:22", { resolver: dns }), { refused: "port" });
  assert.deepEqual(await egressTarget("garbage", { resolver: dns }), { refused: "bad_authority" });
});

test("the proxy refuses CONNECT to internal targets and plain HTTP, and tunnels an allowed one", async () => {
  // A stand-in upstream on loopback, reachable only through the test hook for its name.
  const upstream = createServer((socket) => socket.end("hello from upstream"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const refused: string[] = [];
  const proxy = createEgressProxy({
    ports: [443, upstreamPort],
    resolver: async (host) =>
      host === "fixture.test" || host === "canary.test" ? [{ address: "127.0.0.1", family: 4 }] : [],
    allowAddress: (_address, host) => host === "fixture.test",
    onRefused: (host, reason) => refused.push(`${host}:${reason}`),
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;
  const send = (text: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(proxyPort, "127.0.0.1", () => socket.write(text));
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
      setTimeout(() => socket.destroy(), 3000);
    });
  try {
    for (const target of ["169.254.169.254:443", "127.0.0.1:443", "172.17.0.1:443", `canary.test:${upstreamPort}`])
      assert.match(await send(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`), /^HTTP\/1\.1 403/, target);
    assert.match(await send("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n"), /^HTTP\/1\.1 403/);
    const tunnel = await send(`CONNECT fixture.test:${upstreamPort} HTTP/1.1\r\nHost: fixture.test\r\n\r\n`);
    assert.match(tunnel, /^HTTP\/1\.1 200 Connection Established/);
    assert.match(tunnel, /hello from upstream/);
    assert.ok(refused.includes(`canary.test:address`), refused.join());
  } finally {
    proxy.close();
    upstream.close();
  }
});

const listening = async <T extends { listen: Function; address: Function }>(server: T) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

test("the proxy counts CONNECTs still waiting for DNS against its cap and frees them on every outcome", async () => {
  const lookups: Array<(answer: Array<{ address: string; family: number }>) => void> = [];
  const proxy = createEgressProxy({
    maxConnections: 1,
    resolver: (host) =>
      host === "slow.test"
        ? new Promise((resolve) => lookups.push(resolve))
        : Promise.resolve([{ address: "10.0.0.5", family: 4 }]),
  });
  const proxyPort = await listening(proxy);
  const send = (target: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(proxyPort, "127.0.0.1", () =>
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
      );
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
      setTimeout(() => socket.destroy(), 3000);
    });
  try {
    const slow = send("slow.test:443");
    while (!lookups.length) await new Promise((resolve) => setTimeout(resolve, 5));
    // The only slot is held by the pending lookup.
    assert.match(await send("other.test:443"), /^HTTP\/1\.1 503[^]*x-egress-refused: busy/);
    lookups[0]([{ address: "10.0.0.5", family: 4 }]);
    assert.match(await slow, /^HTTP\/1\.1 403[^]*x-egress-refused: address/);
    // Refused after the lookup: the slot is free again.
    assert.match(await send("other.test:443"), /^HTTP\/1\.1 403[^]*x-egress-refused: address/);
  } finally {
    proxy.close();
  }
});

test("a proxied GET settles when a compressed body is cut off mid-stream", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polka-renderer-tls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=fixture.test"].concat([
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ]),
      { stdio: "ignore" },
    );
  } catch {
    return t.skip("openssl is not available");
  }
  const body = gzipSync(Buffer.from("<title>Cut</title>" + "x".repeat(200_000)));
  // Headers, then half of the gzip bytes, then the connection drops: no end, no error from the decoder itself.
  const site = createTlsServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    (socket) => {
      socket.once("data", () => {
        socket.write(
          `HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-encoding: gzip\r\ncontent-length: ${body.length}\r\n\r\n`,
        );
        socket.write(body.subarray(0, body.length >> 1), () => setTimeout(() => socket.destroy(), 50));
      });
      socket.on("error", () => undefined);
    },
  );
  const sitePort = await listening(site);
  const proxy = createEgressProxy({
    ports: [sitePort],
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    allowAddress: (_address, host) => host === "fixture.test",
  });
  const proxyPort = await listening(proxy);
  try {
    const get = proxiedGet(proxyPort, { insecure: true });
    const started = Date.now();
    const outcome = await Promise.race([
      get(`https://fixture.test:${sitePort}/`, { timeoutMs: 10_000 }).then(
        () => "resolved",
        (error) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 4000).unref()),
    ]);
    assert.ok(outcome instanceof FetchFailure, String(outcome));
    assert.equal(outcome.reason, "network");
    assert.ok(Date.now() - started < 4000);
  } finally {
    proxy.close();
    site.close();
  }
});

test("/fetch: allowlist, robots.txt first, redirects only within the allowlist, bot checks, one attempt", async () => {
  const SHARE = "https://chatgpt.com/share/68063082-c2d8-8012-8d45-fa674aa1c1ed";
  const answers: Record<string, ProxiedAnswer> = {
    "https://chatgpt.com/robots.txt": {
      status: 200,
      headers: {},
      body: Buffer.from("User-agent: *\nDisallow: /\nAllow: /share/\nAllow: /canvas/shared/\n"),
    },
    [SHARE]: {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from("<title>ChatGPT - x</title>" + "y".repeat(6000)),
    },
  };
  const asked: string[] = [];
  const get: ProxiedGet = async (url) => {
    asked.push(url);
    const answer = answers[url];
    if (!answer) throw Error(`unexpected ${url}`);
    return answer;
  };
  const robots = robotsVia(get);
  const ok = await fetchPage(get, robots, SHARE);
  assert.ok("html" in ok && ok.finalUrl === SHARE && ok.status === 200);
  assert.deepEqual(asked, ["https://chatgpt.com/robots.txt", SHARE]);
  assert.deepEqual(await fetchPage(get, robots, "https://chatgpt.com/c/68063082-c2d8-8012-8d45-fa674aa1c1ed"), {
    error: "not_allowed",
  });
  assert.deepEqual(await fetchPage(get, robots, "https://example.com/share/x"), { error: "not_allowed" });
  // A redirect out of the allowlist (a login page) is refused, not followed.
  const MOVED = "https://chatgpt.com/share/6aa18924-7ee8-83ee-a6d3-46731e8b1f6b";
  answers[MOVED] = { status: 302, headers: { location: "/auth/login" }, body: Buffer.alloc(0) };
  assert.deepEqual(await fetchPage(get, robots, MOVED), { error: "not_allowed", detail: "redirect" });
  const BLOCKED = "https://chatgpt.com/share/6a2c4eab-b7f0-83eb-99d3-7875da25e53f";
  answers[BLOCKED] = {
    status: 403,
    headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
    body: Buffer.from("<title>Just a moment...</title>"),
  };
  const before = asked.length;
  assert.equal(((await fetchPage(get, robots, BLOCKED)) as any).error, "source_blocked");
  assert.equal(asked.length - before, 1, "no retry after a challenge (robots.txt came from the cache)");
  const GONE = "https://chatgpt.com/share/6ab33cb3-73ec-83e8-90a4-2a1b8ff99a08";
  answers[GONE] = {
    status: 404,
    headers: { "content-type": "text/html" },
    body: Buffer.from("<title>Not found</title>" + "z".repeat(6000)),
  };
  assert.deepEqual(await fetchPage(get, robots, GONE), { error: "navigation_failed", detail: "http_404" });
  // robots.txt that closes the page, or cannot be read, stops the fetch before it.
  const closed = robotsVia(async (url) =>
    url.endsWith("/robots.txt")
      ? { status: 200, headers: {}, body: Buffer.from("User-agent: PolkaRenderer\nDisallow: /share/") }
      : answers[SHARE],
  );
  assert.deepEqual(await fetchPage(get, closed, SHARE), { error: "robots_disallowed" });
  const down = robotsVia(async () => ({ status: 503, headers: {}, body: Buffer.alloc(0) }));
  assert.deepEqual(await fetchPage(get, down, SHARE), { error: "robots_unavailable" });
});
