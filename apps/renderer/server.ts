import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chromium, type Browser } from "playwright-core";
import {
  verifyRenderRequest,
  type RenderResult,
} from "../../packages/renderer-contract.ts";
import { createEgressProxy } from "./egress-proxy.ts";
import { renderPage, type RenderOptions } from "./render.ts";

/*
 * Полка's headless renderer (docs/specs/URL_IMPORT_SUPPORT.md, «Рендерер»).
 * One operation: POST /render {url} → the rendered DOM of an allowlisted
 * public page, or an error code. Every request is signed by the app
 * (packages/renderer-contract.ts). Pages are rendered one at a time; a short
 * queue waits, anything beyond it gets «busy». The process holds no database,
 * storage or user credentials: what it could leak is only what it renders.
 *
 * Environment: RENDERER_SECRET (≥ 32 characters, shared with the app),
 * RENDERER_PORT (4395), RENDERER_HOST (0.0.0.0 in the container),
 * EGRESS_PORT (3128, loopback only), RENDERER_CHROMIUM_SANDBOX (true by
 * default; false only where the kernel refuses Chromium's sandbox).
 */

const MAX_BODY = 8 * 1024;
const MAX_QUEUE = 3;

export type RendererOptions = {
  secret: string;
  browser: () => Promise<Browser>;
  render?: RenderOptions;
  /** Test hook: the fixture listens on a random port. Never set in production. */
  anyPort?: boolean;
};

export function createRenderer({ secret, browser, render, anyPort = false }: RendererOptions) {
  if (secret.length < 32) throw new Error("RENDERER_SECRET must be at least 32 characters");
  let chain: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  const enqueue = (task: () => Promise<RenderResult>): Promise<RenderResult> => {
    if (waiting > MAX_QUEUE) return Promise.resolve({ error: "busy" });
    waiting++;
    const next = chain.then(task).finally(() => waiting--);
    chain = next.catch(() => {});
    return next;
  };
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true });
    if (req.method !== "POST" || req.url !== "/render") return send(404, { error: "bad_request" });
    let body = "";
    try {
      body = await readBody(req);
    } catch {
      return send(413, { error: "bad_request" });
    }
    if (!verifyRenderRequest(secret, req.headers, "POST", "/render", body)) return send(401, { error: "unauthorized" });
    let url: string;
    try {
      const parsed = JSON.parse(body) as { url?: unknown };
      if (typeof parsed.url !== "string" || parsed.url.length > 2048) throw new Error();
      const target = new URL(parsed.url);
      if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443" && !anyPort)) throw new Error();
      target.hash = "";
      url = target.href;
    } catch {
      return send(400, { error: "bad_request" });
    }
    const result = await enqueue(async () => renderPage(await browser(), url, render));
    // Counts and outcomes only: the URL is the user's and stays out of logs.
    console.log(JSON.stringify({ event: "render", outcome: "error" in result ? result.error : "ok", ms: Date.now() - started }));
    send("error" in result ? (result.error === "busy" ? 503 : 422) : 200, result);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Chromium goes out only through the egress proxy, loopback included (<-loopback>). */
export function launchBrowser(proxyPort: number, sandbox: boolean) {
  return chromium.launch({
    headless: true,
    chromiumSandbox: sandbox,
    proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: "<-loopback>" },
    args: [
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--force-webrtc-ip-handling-policy",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-sync",
      "--dns-prefetch-disable",
      "--no-pings",
      "--disable-features=DnsOverHttps,InterestFeedContentSuggestions",
    ],
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.env.RENDERER_SECRET ?? "";
  const port = Number(process.env.RENDERER_PORT ?? 4395);
  const host = process.env.RENDERER_HOST ?? "127.0.0.1";
  const egressPort = Number(process.env.EGRESS_PORT ?? 3128);
  const sandbox = process.env.RENDERER_CHROMIUM_SANDBOX !== "false";
  let refused = 0;
  const proxy = createEgressProxy({ onRefused: () => void refused++ });
  await new Promise<void>((resolve) => proxy.listen(egressPort, "127.0.0.1", resolve));
  let current: Promise<Browser> | null = null;
  const browser = () => {
    current ??= launchBrowser(egressPort, sandbox).then((b) => {
      b.on("disconnected", () => (current = null));
      return b;
    });
    return current;
  };
  await browser();
  const server = createRenderer({ secret, browser });
  server.listen(port, host, () => console.log(JSON.stringify({ event: "renderer.ready", port, sandbox })));
  setInterval(() => {
    if (refused) console.log(JSON.stringify({ event: "egress.refused", count: refused }));
    refused = 0;
  }, 60_000).unref();
  const stop = () => {
    server.close();
    proxy.close();
    void current?.then((b) => b.close()).finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
