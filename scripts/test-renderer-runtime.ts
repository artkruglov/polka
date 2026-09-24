// Runtime check of the headless renderer (apps/renderer), in two parts:
//
// 1. Browser: a local SPA fixture (an empty shell that builds its page with
//    JavaScript and CSS-in-JS) is rendered by the real renderer service and
//    Chromium, through the real egress proxy. The fixture also tries to reach
//    169.254.169.254, a loopback «canary» server and a name that resolves to a
//    private address, and to open a WebSocket: all must fail, the canary must
//    see no request. A Cloudflare-style challenge page must come back as
//    source_blocked, an unsigned request as 401, a non-allowlisted URL as
//    not_allowed.
// 2. Docker (skipped with a note when Docker is absent): the renderer image is
//    built and started with the compose hardening; from inside it the proxy
//    must refuse 169.254.169.254, the Docker network's gateway and 127.0.0.1,
//    and /render must refuse unsigned and non-allowlisted requests.
//
//   npm run test:renderer-runtime
//
// Needs Playwright's Chromium for part 1 (npx playwright-core install
// chromium-headless-shell, or an existing ~/.cache/ms-playwright).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createEgressProxy } from "../apps/renderer/egress-proxy.ts";
import { createRenderer } from "../apps/renderer/server.ts";
import { signRenderRequest } from "../packages/renderer-contract.ts";

const SECRET = "runtime-test-secret-0123456789abcdef";
const FIXTURE = "spa.fixture.test";
const results: string[] = [];
const pass = (name: string) => {
  results.push(`ok  ${name}`);
  console.log(`ok  ${name}`);
};

async function render(base: string, url: string, secret = SECRET) {
  const body = JSON.stringify({ url });
  const response = await fetch(`${base}/render`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...(secret ? signRenderRequest(secret, "POST", "/render", body) : {}) },
  });
  return { status: response.status, body: (await response.json()) as any };
}

// ---- part 1: the renderer with a local fixture ----
const dir = mkdtempSync(join(tmpdir(), "polka-renderer-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=fixture.test",
  "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
const tls = { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
let canaryHits = 0;
const canary = createHttps(tls, (_req, res) => {
  canaryHits++;
  res.end("secret");
});
await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
const canaryPort = (canary.address() as AddressInfo).port;
const fixture = createHttps(tls, (req, res) => {
  if (req.url === "/challenge") {
    res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
    return res.end("<!doctype html><title>Just a moment...</title><p>Checking your browser");
  }
  if (req.url === "/app.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(`
      const root = document.getElementById("root");
      const style = document.createElement("style"); document.head.append(style);
      style.sheet.insertRule(".card { color: rgb(1, 2, 3); }");
      root.innerHTML = '<h1 class="card">Rendered by the SPA</h1><ul id="probes"></ul>';
      document.title = "Fixture SPA";
      const probe = (name, value) => { const li = document.createElement("li"); li.dataset.probe = name; li.textContent = name + ":" + value; document.getElementById("probes").append(li); };
      probe("websocket", typeof WebSocket);
      probe("rtc", typeof RTCPeerConnection);
      probe("serviceworker", typeof navigator.serviceWorker);
      const reach = (name, url) => fetch(url, { mode: "no-cors" }).then(() => probe(name, "reached"), () => probe(name, "blocked"));
      Promise.all([
        reach("metadata", "https://169.254.169.254/latest/meta-data/"),
        reach("loopback", "https://127.0.0.1:${canaryPort}/"),
        reach("canary-name", "https://canary.fixture.test:${canaryPort}/"),
        reach("private-name", "https://internal.fixture.test/"),
      ]).then(() => document.body.dataset.done = "1");
    `);
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end('<!doctype html><html><head><title>Loading…</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixturePort = (fixture.address() as AddressInfo).port;
const refused: string[] = [];
const proxy = createEgressProxy({
  ports: [443, fixturePort, canaryPort],
  resolver: async (host) =>
    host === FIXTURE || host === "canary.fixture.test"
      ? [{ address: "127.0.0.1", family: 4 }]
      : host === "internal.fixture.test"
        ? [{ address: "10.0.0.5", family: 4 }]
        : [],
  // Only the fixture's own name may use loopback; everything else follows the production rule.
  allowAddress: (_address, host) => host === FIXTURE,
  onRefused: (host, reason) => refused.push(`${host}:${reason}`),
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = (proxy.address() as AddressInfo).port;
const browser = await chromium.launch({
  headless: true,
  proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: "<-loopback>" },
  args: ["--webrtc-ip-handling-policy=disable_non_proxied_udp", "--force-webrtc-ip-handling-policy"],
});
const origin = `https://${FIXTURE}:${fixturePort}`;
const service = createRenderer({
  secret: SECRET,
  anyPort: true,
  browser: async () => browser,
  render: { allow: (url) => new URL(url).hostname === FIXTURE, ignoreHTTPSErrors: true },
});
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
try {
  const spa = await render(base, `${origin}/`);
  assert.equal(spa.status, 200, JSON.stringify(spa.body));
  assert.equal(spa.body.title, "Fixture SPA");
  assert.match(spa.body.html, /Rendered by the SPA/);
  assert.match(spa.body.html, /\.card \{ color: rgb\(1, 2, 3\); \}/, "CSSOM-only rules are serialized");
  pass("SPA fixture rendered: DOM and CSS-in-JS rules in the snapshot");
  for (const [name, value] of [["websocket", "undefined"], ["rtc", "undefined"], ["serviceworker", "undefined"]])
    assert.match(spa.body.html, new RegExp(`${name}:${value}`), name);
  pass("WebSocket, WebRTC and service workers are unavailable to the page");
  for (const name of ["metadata", "loopback", "canary-name", "private-name"])
    assert.match(spa.body.html, new RegExp(`${name}:blocked`), `${name} must be blocked: ${spa.body.html.match(/<ul id="probes">.*?<\/ul>/)?.[0]}`);
  assert.equal(canaryHits, 0, "the loopback canary saw no request");
  assert.ok(refused.some((r) => r.startsWith("169.254.169.254")), refused.join());
  assert.ok(refused.some((r) => r === "internal.fixture.test:address"), refused.join());
  pass("egress: 169.254.169.254, 127.0.0.1 and private names refused by the proxy; canary untouched");
  const challenge = await render(base, `${origin}/challenge`);
  assert.equal(challenge.body.error, "source_blocked");
  pass("challenge page → source_blocked, no retry");
  assert.equal((await render(base, `${origin}/`, "")).status, 401);
  assert.equal((await render(base, `${origin}/`, "another-secret-another-secret-0000")).status, 401);
  pass("unsigned or wrongly signed requests → 401");
  assert.equal((await render(base, "https://example.com/")).body.error, "not_allowed");
  pass("a host outside the allowlist → not_allowed");
} finally {
  service.close();
  await browser.close();
  proxy.close();
  fixture.close();
  canary.close();
  rmSync(dir, { recursive: true, force: true });
}

// ---- part 2: the Docker image ----
const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
if (docker.status !== 0) {
  console.log("skip Docker part: Docker is not available. Run it on a machine with Docker (deploy/renderer/README.md, «Проверка»).");
} else {
  const name = `polka-renderer-test-${process.pid}`;
  const run = (args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
  run(["build", "-q", "-f", "apps/renderer/Dockerfile", "-t", "polka-renderer:test", "."]);
  run(["run", "-d", "--name", name, "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=256m", "--shm-size", "256m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "1536m", "--pids-limit", "256",
    "-e", `RENDERER_SECRET=${SECRET}`, "-p", "127.0.0.1::4395", "polka-renderer:test"]);
  try {
    const gateway = run(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}", name]) || "172.17.0.1";
    const port = run(["port", name, "4395/tcp"]).split(":").pop();
    const dockerBase = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
      if (await fetch(`${dockerBase}/healthz`).then((r) => r.ok, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const probe = run(["exec", name, "node", "-e", `
      const net = require("net");
      const targets = ["169.254.169.254:443", "${gateway}:443", "127.0.0.1:443", "127.0.0.1:4395", "[::1]:443"];
      (async () => { const out = {};
        for (const t of targets) out[t] = await new Promise((done) => {
          const s = net.connect(3128, "127.0.0.1", () => s.write("CONNECT " + t + " HTTP/1.1\\r\\nHost: " + t + "\\r\\n\\r\\n"));
          let d = ""; s.on("data", (c) => { d += c; if (d.includes("\\r\\n\\r\\n")) { s.destroy(); done(d.split("\\r\\n")[0]); } });
          s.on("error", (e) => done("error " + e.message)); setTimeout(() => { s.destroy(); done("timeout"); }, 8000);
        });
        console.log(JSON.stringify(out)); })();`]);
    const verdicts = JSON.parse(probe) as Record<string, string>;
    for (const [target, line] of Object.entries(verdicts)) assert.match(line, /^HTTP\/1\.1 403/, `${target}: ${line}`);
    pass(`docker egress: proxy refuses 169.254.169.254, the docker gateway ${gateway} and 127.0.0.1`);
    assert.equal((await render(dockerBase, "https://example.com/")).body.error, "not_allowed");
    assert.equal((await render(dockerBase, "https://demo.lovable.app/", "")).status, 401);
    pass("docker /render: unsigned → 401, non-allowlisted → not_allowed");
    const user = run(["exec", name, "id", "-un"]);
    assert.equal(user, "pwuser");
    pass("docker: runs as pwuser with a read-only root and no capabilities");
  } finally {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
}
console.log(`\n${results.length} checks passed`);
