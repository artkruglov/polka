import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  SNAPSHOT_MAX_BODY,
  SNAPSHOT_MAX_IMAGE,
  signRenderRequest,
  type SnapshotResult,
} from "../../packages/renderer-contract.ts";
import { config } from "./config.ts";
import { rendererUrlAllowed } from "./url-import/renderer-url.ts";

/*
 * The app's side of POST /snapshot (packages/renderer-contract.ts): the saved
 * page goes out signed, a JPEG of its first screen comes back. Only for
 * shelf covers (covers.ts); the renderer keeps nothing.
 */

export type SnapshotCall = (
  page: { html: string; script: boolean },
  signal?: AbortSignal,
) => Promise<SnapshotResult>;

const ERRORS = new Set(["timeout", "navigation_failed", "too_large", "busy", "bad_request", "unauthorized"]);
const MAX_ANSWER = Math.ceil(SNAPSHOT_MAX_IMAGE * 1.4) + 1024;

export function snapshotClient({
  base = config.RENDERER_URL,
  secret = config.RENDERER_SECRET,
  ca = config.RENDERER_CA,
  timeoutMs = 30_000,
}: { base?: string; secret?: string; ca?: string; timeoutMs?: number } = {}): SnapshotCall {
  return async (page, signal) => {
    if (!base || !secret || !rendererUrlAllowed(base)) throw new Error("renderer is not configured");
    const body = JSON.stringify(page);
    if (Buffer.byteLength(body) > SNAPSHOT_MAX_BODY) return { error: "too_large" };
    const target = new URL("/snapshot", base);
    const abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(
        target,
        {
          method: "POST",
          signal: abort,
          agent: false,
          ...(target.protocol === "https:" && ca ? { ca: ca.replace(/\\n/g, "\n") } : {}),
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            ...signRenderRequest(secret, "POST", "/snapshot", body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ANSWER) {
              res.destroy();
              reject(new Error("renderer answer too large"));
            } else chunks.push(chunk);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    return parseSnapshotAnswer(answer.status, answer.text);
  };
}

/** Accepts only the contract's shapes and sizes; anything else is the renderer failing. */
export function parseSnapshotAnswer(status: number, text: string): SnapshotResult {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`renderer answered HTTP ${status} without JSON`);
  }
  if (value && typeof value.error === "string") {
    if (!ERRORS.has(value.error)) throw new Error("renderer answered an unknown error");
    return { error: value.error };
  }
  if (status !== 200) throw new Error("renderer answered an unexpected shape");
  if (value?.blank === true) return { blank: true };
  if (value?.blank !== false || typeof value.image !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.image))
    throw new Error("renderer answered an unexpected shape");
  const image = Buffer.from(value.image, "base64");
  // A JPEG, and not larger than the table keeps.
  if (image.length > SNAPSHOT_MAX_IMAGE || image[0] !== 0xff || image[1] !== 0xd8)
    throw new Error("renderer answered an unexpected picture");
  return { image: value.image, blank: false };
}
