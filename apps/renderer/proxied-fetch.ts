import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { RENDERER_USER_AGENT } from "../../packages/renderer-contract.ts";

/*
 * One HTTPS GET from the renderer without a browser, through the same egress
 * proxy as Chromium (CONNECT, so the proxy's public-address and DNS-pinning
 * rule applies to it too). Used for /fetch pages and for robots.txt. No
 * cookies, no retries; redirects are the caller's decision.
 */

export type ProxiedAnswer = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
export type ProxiedGet = (url: string, options?: { maxBytes?: number; timeoutMs?: number; accept?: string }) => Promise<ProxiedAnswer>;

// No parameter properties: the image runs this file with Node's type stripping.
export class FetchFailure extends Error {
  reason: "refused" | "too_large" | "timeout" | "network";
  constructor(reason: FetchFailure["reason"], message: string = reason) {
    super(message);
    this.reason = reason;
  }
}

export function proxiedGet(proxyPort: number, { insecure = false }: { insecure?: boolean } = {}): ProxiedGet {
  return (input, { maxBytes = 5 * 1024 * 1024, timeoutMs = 15_000, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" } = {}) =>
    new Promise<ProxiedAnswer>((resolve, reject) => {
      const url = new URL(input);
      if (url.protocol !== "https:") return reject(new FetchFailure("refused", "https only"));
      const port = Number(url.port || 443);
      const signal = AbortSignal.timeout(timeoutMs);
      const fail = (error: unknown) => reject(error instanceof FetchFailure ? error : signal.aborted ? new FetchFailure("timeout") : new FetchFailure("network"));
      const tunnel = httpRequest({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `${url.hostname}:${port}`, signal });
      tunnel.on("error", fail);
      tunnel.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return fail(new FetchFailure("refused", `egress ${res.statusCode}`));
        }
        const secure = tlsConnect({ socket, servername: url.hostname, rejectUnauthorized: !insecure });
        const req = httpsRequest(
          url,
          {
            method: "GET",
            signal,
            // The tunnel is the connection: no agent, no pooling, no cookies.
            createConnection: () => secure,
            headers: {
              "user-agent": RENDERER_USER_AGENT,
              accept,
              "accept-encoding": "gzip, deflate, br",
              "accept-language": "ru,en;q=0.8",
            },
          },
          (answer) => {
            const encoding = String(answer.headers["content-encoding"] ?? "identity").toLowerCase();
            const stream: Readable =
              encoding === "gzip" ? answer.pipe(createGunzip()) : encoding === "deflate" ? answer.pipe(createInflate()) : encoding === "br" ? answer.pipe(createBrotliDecompress()) : answer;
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxBytes) {
                answer.destroy();
                stream.destroy();
                fail(new FetchFailure("too_large"));
              } else chunks.push(chunk);
            });
            stream.on("error", fail);
            stream.on("end", () => {
              secure.end();
              resolve({ status: answer.statusCode ?? 0, headers: answer.headers, body: Buffer.concat(chunks) });
            });
          },
        );
        req.on("error", fail);
        req.end();
      });
      tunnel.end();
    });
}
