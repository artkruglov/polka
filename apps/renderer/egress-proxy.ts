import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { publicAddress } from "../../packages/public-address.ts";

/*
 * The renderer's only way out. Chromium is started with --proxy-server
 * pointing here and <-loopback> removed from its bypass list, so every
 * request of a page (documents, subresources, fetch, WebSocket upgrades)
 * arrives as a CONNECT. For each one the proxy resolves the host once, refuses
 * it unless every address is public (packages/public-address.ts: no loopback,
 * RFC 1918 or docker networks, no 169.254.169.254 metadata, no IPv6 ULA or
 * link-local) and connects to that same pinned address, so DNS rebinding
 * cannot swap it afterwards. Only port 443: pages are HTTPS, plain HTTP
 * requests are refused. It logs counts, never URLs.
 *
 * Why an in-container proxy rather than a second container: the renderer may
 * run alone on its own VM (deploy/renderer), and one process tree with one
 * rule is the simplest thing to reason about. Container and VM firewalls
 * (deploy/renderer/README.md) are the second layer, in case Chromium ever
 * ignored its proxy setting.
 */

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
export type EgressPolicy = {
  resolver?: Resolver;
  /** Test hook: an extra verdict for an address (the fixture). Never set in production. */
  allowAddress?: (address: string, host: string) => boolean;
  ports?: readonly number[];
  maxConnections?: number;
  idleMs?: number;
  onRefused?: (host: string, reason: string) => void;
};

const defaultResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/** Resolves host:port and returns the pinned address, or why it is refused. */
export async function egressTarget(
  authority: string,
  { resolver = defaultResolver, allowAddress, ports = [443] }: EgressPolicy = {},
): Promise<{ address: string; port: number; host: string } | { refused: string }> {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority);
  if (!match) return { refused: "bad_authority" };
  const host = match[1].replace(/^\[|\]$/g, "").toLowerCase();
  const port = Number(match[2]);
  if (!ports.includes(port)) return { refused: "port" };
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host);
  } catch {
    return { refused: "dns" };
  }
  const allowed = (address: string) => publicAddress(address) || !!allowAddress?.(address, host);
  if (!addresses.length || addresses.some((a) => !allowed(a.address))) return { refused: "address" };
  return { address: addresses[0].address, port, host };
}

export function createEgressProxy(policy: EgressPolicy = {}): Server {
  const { maxConnections = 64, idleMs = 30_000, onRefused } = policy;
  let open = 0;
  const server = createServer((req, res) => {
    // Plain-HTTP proxying (GET http://…) is not offered: every allowed page is HTTPS.
    onRefused?.(hostOf(req), "plain_http");
    res.writeHead(403, { connection: "close" }).end();
  });
  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    if (open >= maxConnections) return refuse(client, "busy", 503);
    const target = await egressTarget(req.url ?? "", policy);
    if ("refused" in target) {
      onRefused?.(hostOf(req), target.refused);
      return refuse(client, target.refused, 403);
    }
    open++;
    const upstream = connect({ host: target.address, port: target.port });
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.setTimeout(idleMs, close);
    client.setTimeout(idleMs, close);
    upstream.once("close", () => {
      open--;
      client.destroy();
    });
    upstream.on("error", close);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  return server;
}

function refuse(client: Socket, reason: string, status: number) {
  client.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Busy"}\r\nx-egress-refused: ${reason}\r\nconnection: close\r\n\r\n`);
}

function hostOf(req: IncomingMessage) {
  return (req.url ?? "").replace(/^[a-z]+:\/\//i, "").split(/[/:]/)[0] ?? "";
}
