import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  RENDER_MAX_HTML,
  signRenderRequest,
  type FetchResult,
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
export type FetchCall = (url: string, signal?: AbortSignal) => Promise<FetchResult>;
const MAX_ANSWER = 12 * 1024 * 1024;
type Options = { base?: string; secret?: string; ca?: string; timeoutMs?: number };

export function rendererClient(options: Options = {}): RenderCall {
  const call = signedCall("/render", options);
  return async (url, signal) => {
    const answer = await call(url, signal);
    return parseRenderAnswer(answer.status, answer.text);
  };
}

/** POST /fetch: one plain GET made by the renderer (ChatGPT share pages). */
export function rendererFetchClient(options: Options = {}): FetchCall {
  const call = signedCall("/fetch", options);
  return async (url, signal) => {
    const answer = await call(url, signal);
    return parseFetchAnswer(answer.status, answer.text);
  };
}

function signedCall(
  path: "/render" | "/fetch",
  { base = config.RENDERER_URL, secret = config.RENDERER_SECRET, ca = config.RENDERER_CA, timeoutMs = 60_000 }: Options,
) {
  return async (url: string, signal?: AbortSignal) => {
    if (!base || !secret || !rendererUrlAllowed(base)) throw new Error("renderer is not configured");
    const target = new URL(path, base);
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
            ...signRenderRequest(secret, "POST", path, body),
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
    return answer;
  };
}

const ERRORS = new Set(["source_blocked", "robots_disallowed", "robots_unavailable", "timeout", "not_allowed", "navigation_failed", "too_large", "busy", "bad_request", "unauthorized"]);

function errorAnswer(value: any): { error: any; detail?: string } | null {
  if (!value || typeof value.error !== "string") return null;
  if (!ERRORS.has(value.error)) throw new Error("renderer answered an unknown error");
  return { error: value.error, ...(typeof value.detail === "string" ? { detail: value.detail.slice(0, 100) } : {}) };
}

export function parseFetchAnswer(status: number, text: string): FetchResult {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`renderer answered HTTP ${status} without JSON`);
  }
  const failed = errorAnswer(value);
  if (failed) return failed;
  if (status !== 200 || typeof value?.finalUrl !== "string" || typeof value.html !== "string" || typeof value.status !== "number")
    throw new Error("renderer answered an unexpected shape");
  if (Buffer.byteLength(value.html) > RENDER_MAX_HTML) return { error: "too_large" };
  return { finalUrl: value.finalUrl, status: value.status, html: value.html };
}

/** Accepts only the contract's shapes and sizes; anything else is the renderer failing. */
export function parseRenderAnswer(status: number, text: string): RenderResult {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`renderer answered HTTP ${status} without JSON`);
  }
  const failed = errorAnswer(value);
  if (failed) return failed;
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
