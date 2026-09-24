import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  RENDER_MAX_HTML,
  signRenderRequest,
  type RenderResult,
} from "../../../packages/renderer-contract.ts";
import { config } from "../config.ts";
import { rendererUrlAllowed } from "./renderer-url.ts";

/*
 * The app's side of POST /render (packages/renderer-contract.ts). Only the
 * signed URL goes out; only HTML comes back, capped: the page and its frames
 * at 5 MB each (the whole answer at 12 MB). Resources of the snapshot are
 * fetched and localised by the app itself through fetchPublic.
 */

export type RenderCall = (url: string, signal?: AbortSignal) => Promise<RenderResult>;
const MAX_ANSWER = 12 * 1024 * 1024;

export function rendererClient({
  base = config.RENDERER_URL,
  secret = config.RENDERER_SECRET,
  ca = config.RENDERER_CA,
  timeoutMs = 60_000,
}: { base?: string; secret?: string; ca?: string; timeoutMs?: number } = {}): RenderCall {
  return async (url, signal) => {
    if (!base || !secret || !rendererUrlAllowed(base)) throw new Error("renderer is not configured");
    const target = new URL("/render", base);
    const body = JSON.stringify({ url });
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
            ...signRenderRequest(secret, "POST", "/render", body),
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
    return parseRenderAnswer(answer.status, answer.text);
  };
}

const ERRORS = new Set(["source_blocked", "timeout", "not_allowed", "navigation_failed", "too_large", "busy", "bad_request", "unauthorized"]);

/** Accepts only the contract's shapes and sizes; anything else is the renderer failing. */
export function parseRenderAnswer(status: number, text: string): RenderResult {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`renderer answered HTTP ${status} without JSON`);
  }
  if (value && typeof value.error === "string") {
    if (!ERRORS.has(value.error)) throw new Error("renderer answered an unknown error");
    return { error: value.error, ...(typeof value.detail === "string" ? { detail: value.detail.slice(0, 100) } : {}) };
  }
  if (
    status !== 200 ||
    typeof value?.finalUrl !== "string" ||
    typeof value.html !== "string" ||
    typeof value.title !== "string" ||
    !Array.isArray(value.frames)
  )
    throw new Error("renderer answered an unexpected shape");
  if (Buffer.byteLength(value.html) > RENDER_MAX_HTML) return { error: "too_large" };
  const frames: Array<{ url: string; html: string }> = [];
  let frameBytes = 0;
  for (const frame of value.frames.slice(0, 8)) {
    if (typeof frame?.url !== "string" || typeof frame.html !== "string") continue;
    frameBytes += Buffer.byteLength(frame.html);
    if (frameBytes > RENDER_MAX_HTML) break;
    frames.push({ url: frame.url, html: frame.html });
  }
  return { finalUrl: value.finalUrl, title: value.title.slice(0, 300), html: value.html, frames };
}
