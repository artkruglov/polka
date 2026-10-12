// How one webhook leaves Полка (docs/specs/WEBHOOKS.md): the address check
// against SSRF, the signature and the POST itself. No database here.
//
// The address must be https on the default port, without a login, and every
// address its name resolves to must be public (packages/public-address.ts,
// the importer's and the renderer's check: no loopback, RFC 1918, CGNAT,
// link-local with 169.254.169.254, ULA fc00::/7…). The name is resolved
// again for every attempt and the connection is pinned to the address that
// passed, so a name that changes its answer between the check and the
// connection (DNS rebinding) reaches nothing private. Redirects are not
// followed, the deadline is short, and only the first bytes of the answer
// are read, for the log.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Resolver as DnsResolver } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { publicAddress } from "../../packages/public-address.ts";
import { WEBHOOK_URL_MAX } from "../../packages/contracts/webhooks.ts";
import { config } from "./config.ts";
import { Problem } from "./errors.ts";

export const WEBHOOK_USER_AGENT = "Polka-Webhooks/1.0";
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** What of the receiver's answer is read at all; the log keeps fewer characters. */
const READ_BYTES = 1024;
export const SNIPPET_CHARS = 200;

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type SendResult = {
  ok: boolean;
  status: number | null;
  /** null on a 2xx; otherwise why the attempt failed. */
  /** `secret`: the stored secret does not open (LINK_KEY changed): nothing was sent. */
  error: "invalid_url" | "blocked_address" | "dns" | "timeout" | "redirect" | "connection" | "http" | "secret" | null;
  snippet: string | null;
};
export type WebhookRequest = { url: string; body: string; headers: Record<string, string> };
export type Transport = (request: WebhookRequest, resolver: Resolver) => Promise<SendResult>;

/** The whole lookup of a name, both families. */
export const DNS_DEADLINE_MS = 3_000;
/**
 * A name asked of the DNS servers directly (c-ares, not getaddrinfo on the
 * libuv thread pool, which a slow name would hold for the system's minutes):
 * A and AAAA at once, 2 s and one try each, and a deadline for both. No
 * /etc/hosts: a webhook names a host on the internet.
 */
const systemResolver: Resolver = async (hostname) => {
  const dns = new DnsResolver({ timeout: 2_000, tries: 1 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      dns.cancel();
      reject(new Error("dns deadline"));
    }, DNS_DEADLINE_MS);
  });
  try {
    const [v4, v6] = await Promise.race([
      Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]),
      deadline,
    ]);
    const addresses = [
      ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (!addresses.length) throw new Error("no addresses");
    return addresses;
  } finally {
    clearTimeout(timer);
  }
};
let network: { resolver: Resolver; transport: Transport } = { resolver: systemResolver, transport: postWebhook };
/** Tests: how names resolve and how requests leave (undefined: the real ones). */
export function setWebhookNetwork(next?: { resolver?: Resolver; transport?: Transport }) {
  network = { resolver: next?.resolver ?? systemResolver, transport: next?.transport ?? postWebhook };
}
export const webhookNetwork = () => network;

export class WebhookUrlError extends Error {
  constructor(
    public code: "invalid_url" | "blocked_address" | "dns",
    message: string,
  ) {
    super(message);
  }
}

/** The address as Полка stores it, or why it cannot be one. */
export function webhookUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new WebhookUrlError("invalid_url", "Нужен полный адрес вебхука, вместе с https в начале.");
  }
  if (url.protocol !== "https:") throw new WebhookUrlError("invalid_url", "Вебхуки отправляются только по https.");
  if (url.username || url.password)
    throw new WebhookUrlError("invalid_url", "Логин и пароль в адресе не поддерживаются: проверяйте подпись запроса.");
  if (url.port && url.port !== "443")
    throw new WebhookUrlError("invalid_url", "Нестандартный порт не поддерживается: только 443.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // A name without a dot, localhost, .local and .internal name an internal network.
  const internalName = !host.includes(".") || /(^|\.)localhost$|\.local$|\.internal$/.test(host);
  if (!isIP(host) && internalName)
    throw new WebhookUrlError(
      "blocked_address",
      "Адрес во внутренней сети: вебхуки отправляются только на адреса в интернете.",
    );
  url.hash = "";
  if (url.href.length > WEBHOOK_URL_MAX) throw new WebhookUrlError("invalid_url", "Адрес — до 2000 символов.");
  return url;
}

/**
 * Resolves the address now; every answer must be public. Returns the
 * addresses to try in turn, IPv4 first (many receivers have no working IPv6).
 */
export async function resolveWebhookTarget(input: string, resolver: Resolver = network.resolver) {
  const url = webhookUrl(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else
    try {
      addresses = await resolver(host);
    } catch {
      throw new WebhookUrlError("dns", "Имя сервера не находится в DNS.");
    }
  if (!addresses.length) throw new WebhookUrlError("dns", "Имя сервера не находится в DNS.");
  if (addresses.some((entry) => !publicAddress(entry.address)))
    throw new WebhookUrlError(
      "blocked_address",
      "Адрес во внутренней сети: вебхуки отправляются только на адреса в интернете.",
    );
  const ordered = [
    ...addresses.filter((entry) => entry.family === 4),
    ...addresses.filter((entry) => entry.family !== 4),
  ];
  return { url, address: ordered[0]!.address, family: ordered[0]!.family, addresses: ordered.slice(0, 4) };
}

/** Registration: a 422 with the reason, before anything is stored. */
export async function assertWebhookUrl(input: string) {
  try {
    return (await resolveWebhookTarget(input)).url.href;
  } catch (error) {
    if (error instanceof WebhookUrlError) throw new Problem(422, "invalid", error.message);
    throw error;
  }
}

/** `Polka-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. */
export function signWebhook(secret: string, timestamp: number, body: string) {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** What a receiver does (and the docs show): the same HMAC, and a fresh timestamp. */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  now = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
) {
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > toleranceSeconds || !parts.v1) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body).split("v1=")[1]!);
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const newWebhookSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;
export const secretHint = (secret: string) => secret.slice(0, 12);

// The secret is kept encrypted: a copy of the database alone signs nothing.
// The endpoint's id is the GCM associated data, so a sealed secret copied to
// another row does not open there.
const secretKey = () => createHmac("sha256", config.LINK_KEY).update("polka:webhook-secret:v1").digest();
export function sealWebhookSecret(secret: string, endpointId: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  cipher.setAAD(Buffer.from(endpointId));
  const sealed = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
}
export function openWebhookSecret(sealed: Buffer, endpointId: string): string {
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(endpointId));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8");
}

/** The request of one attempt: the body and its headers, signed now. */
export function webhookRequest(
  url: string,
  secret: string,
  delivery: { id: string; action: string; payload: unknown },
  now = Math.floor(Date.now() / 1000),
): WebhookRequest {
  const body = JSON.stringify(delivery.payload);
  return {
    url,
    body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": WEBHOOK_USER_AGENT,
      "Polka-Event": delivery.action,
      "Polka-Delivery": delivery.id,
      "Polka-Signature": signWebhook(secret, now, body),
    },
  };
}

const snippet = (bytes: Buffer) => {
  const text = bytes
    .toString("utf8")
    .replace(/[\u0000-\u001f\u007f�]+/g, " ")
    .trim();
  return text ? text.slice(0, SNIPPET_CHARS) : null;
};

/**
 * One POST: the address checked and pinned, no redirects, a short deadline
 * for the whole attempt. An address that refuses the connection gives way to
 * the next one the name resolved to (IPv4 first); an answer of any kind ends it.
 */
export async function postWebhook(
  { url, body, headers }: WebhookRequest,
  resolver: Resolver,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
): Promise<SendResult> {
  let target;
  try {
    target = await resolveWebhookTarget(url, resolver);
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof WebhookUrlError ? error.code : "dns",
      snippet: null,
    };
  }
  const signal = AbortSignal.timeout(timeoutMs);
  let result: SendResult = { ok: false, status: null, error: "connection", snippet: null };
  for (const pinned of target.addresses) {
    result = await postTo(target.url, pinned, body, headers, signal);
    if (result.error !== "connection" || signal.aborted) break;
  }
  return result;
}

/** One attempt to one pinned address; exported for the no-route test. */
export function postTo(
  url: URL,
  pinned: { address: string; family: number },
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const finish = (result: SendResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = () =>
      finish({ ok: false, status: null, error: signal.aborted ? "timeout" : "connection", snippet: null });
    let req;
    try {
      req = request(
        url,
        {
          method: "POST",
          agent: false,
          family: pinned.family,
          signal,
          // Answered on the next tick, as a real lookup is: answered at once, an
          // address the host has no route to fails the connect inside request()
          // (TLS has no socket yet), and the socket's error, with no listener,
          // would take the whole process down (Node 22, EHOSTUNREACH on IPv6).
          lookup: (_host, options, callback: (...args: any[]) => void) =>
            process.nextTick(() =>
              options?.all
                ? callback(null, [{ address: pinned.address, family: pinned.family }])
                : callback(null, pinned.address, pinned.family),
            ),
          headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let size = 0;
          const done = () => {
            res.destroy();
            const ok = status >= 200 && status < 300;
            finish({
              ok,
              status,
              error: ok ? null : status >= 300 && status < 400 ? "redirect" : "http",
              snippet: snippet(Buffer.concat(chunks)),
            });
          };
          res.on("data", (chunk: Buffer) => {
            if (size < READ_BYTES) chunks.push(chunk.subarray(0, READ_BYTES - size));
            size += chunk.length;
            if (size >= READ_BYTES) done();
          });
          res.on("end", done);
          res.on("error", done);
        },
      );
    } catch {
      fail();
      return;
    }
    req.on("error", fail);
    req.end(body);
  });
}
