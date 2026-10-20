// What every connector holds to: credentials go only over TLS, except to
// this machine (the stand's stand-ins); a company's own root CA is trusted
// for that connector's requests only.
import { request as https } from "node:https";
import { readFile } from "node:fs/promises";

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/i;
export const loopback = (host) => LOOPBACK.test(host);

/** Refuses a plain-text address that is not this machine. */
export function secureOnly(url, plain) {
  const u = new URL(url);
  if (u.protocol === plain && !loopback(u.hostname))
    throw new Error(
      `${u.protocol}//${u.host}: пароль без TLS только на этот компьютер — нужен ${plain === "http:" ? "https" : "imaps"}://`,
    );
  return u;
}

export const caOf = (file) => (file ? readFile(file, "utf8") : Promise.resolve(undefined));

/** GET over HTTPS (with the connector's CA) or HTTP to the loopback. */
export async function get(url, { headers = {}, ca, timeout = 30_000 } = {}) {
  const u = secureOnly(url, "http:");
  if (u.protocol === "http:") {
    const r = await fetch(u, { headers, signal: AbortSignal.timeout(timeout) });
    return { status: r.status, text: await r.text() };
  }
  const root = await caOf(ca);
  return new Promise((resolve, reject) => {
    const req = https(u, { headers, timeout, ...(root ? { ca: root } : {}) }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(new Error(e.code ?? e.message)));
    req.end();
  });
}
