import { createHash } from "node:crypto";
import { canonicalizeManifest } from "../../../../packages/contracts/bundle.ts";
import { MAX_TITLE } from "../../../../packages/contracts/index.ts";
import { fetchable } from "../../../../packages/contracts/link-providers.ts";
import { componentShell } from "../../../../packages/contracts/runtime.ts";
import { escapeHtml, htmlTitle, simplePage, sourceBody, type SourceBody } from "../../../../packages/artifact-source.ts";
import type { FetchResult } from "../../../../packages/renderer-contract.ts";
import { checkBuildInWorker } from "../../bundle-derivatives.ts";
import { config } from "../../config.ts";
import { captureHtmlDocument, HtmlCaptureError, type Fetcher } from "../html-capture.ts";
import { fetchPublic, publicUrl } from "../public-fetch.ts";
import { rendererFetchClient, type FetchCall } from "../renderer-client.ts";
import { rendererFailure, rendererUnavailable } from "../rendered.ts";

/*
 * A public ChatGPT share (chatgpt.com/share/<id>) or shared canvas
 * (chatgpt.com/canvas/shared/<id>). robots.txt allows both for every agent,
 * and the content is in the server-rendered HTML, so the renderer reads the
 * page with one plain GET (POST /fetch, as PolkaRenderer, no browser, no
 * retry); Полка's own server never contacts chatgpt.com.
 *
 * The page carries React Router's loader data as a turbo-stream in
 * `streamController.enqueue("…")`. From it, in this order:
 * 1. a canvas (sharedTextdoc, or a canvas created in the conversation) → its
 *    page, component or code;
 * 2. the last code block with HTML, React or SVG in the last assistant reply
 *    → that work (the same reading as the «На Полку» extension:
 *    packages/artifact-source.ts);
 * 3. otherwise the conversation itself as a text page.
 */

// ---- turbo-stream (React Router single fetch) ----

const SPECIAL: Record<number, unknown> = { [-1]: undefined, [-2]: Number.NaN, [-3]: -Infinity, [-4]: -0, [-5]: null, [-6]: Infinity, [-7]: undefined };
const MAX_NODES = 200_000;

/** The first turbo-stream chunk of the page, hydrated into plain values (promises and dates stay opaque). */
export function turboStreamRoot(html: string): unknown {
  const match = /streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/.exec(html);
  if (!match) return null;
  let flat: unknown[];
  try {
    flat = JSON.parse(JSON.parse(match[1]));
  } catch {
    return null;
  }
  if (!Array.isArray(flat)) return null;
  const memo = new Map<number, unknown>();
  let visited = 0;
  const hydrate = (index: unknown): unknown => {
    if (typeof index !== "number") return undefined;
    if (index < 0) return SPECIAL[index];
    if (memo.has(index)) return memo.get(index);
    if (++visited > MAX_NODES) throw new HtmlCaptureError("unsupported_type", "Страница ChatGPT слишком большая для разбора.");
    const value = flat[index];
    if (Array.isArray(value)) {
      // A tagged value (date, promise, error…): ["D", …]; not needed here.
      if (typeof value[0] === "string") return undefined;
      const out: unknown[] = [];
      memo.set(index, out);
      for (const item of value) out.push(hydrate(item));
      return out;
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      memo.set(index, out);
      for (const [key, item] of Object.entries(value)) {
        const name = key.startsWith("_") ? flat[Number(key.slice(1))] : key;
        if (typeof name === "string") out[name] = hydrate(item);
      }
      return out;
    }
    return value;
  };
  return hydrate(0);
}

// ---- what the page holds ----

type Message = { role: "user" | "assistant"; text: string };
type Textdoc = { title: string; type: string; content: string };
export type ChatgptContent = { title: string; canvas: Textdoc | null; messages: Message[] };

const obj = (value: unknown): Record<string, any> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null);

function find(value: unknown, key: string, depth = 0): any {
  const o = obj(value);
  if (!o || depth > 6) return undefined;
  if (key in o) return o[key];
  for (const child of Object.values(o)) {
    const found = find(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function textdoc(value: unknown): Textdoc | null {
  const doc = obj(value);
  if (!doc || typeof doc.content !== "string" || !doc.content.trim()) return null;
  return { title: String(doc.title ?? doc.name ?? "").trim(), type: String(doc.type ?? "document"), content: doc.content };
}

export function parseChatgpt(html: string): ChatgptContent {
  const root = turboStreamRoot(html);
  const loader = obj(find(root, "loaderData"));
  if (!loader) throw new HtmlCaptureError("unsupported_type", "На странице ChatGPT не найден сохранённый разговор: возможно, ссылка удалена или формат страницы изменился.");
  const shared = textdoc(find(loader, "sharedTextdoc"));
  const pageTitle = htmlTitle(html)?.replace(/^ChatGPT\s*[-–—]\s*/, "").trim() ?? "";
  if (shared) return { title: shared.title || pageTitle, canvas: shared, messages: [] };
  const data = obj(obj(find(loader, "serverResponse"))?.data);
  const nodes: unknown[] = Array.isArray(data?.linear_conversation)
    ? data!.linear_conversation
    : Object.values(obj(data?.mapping) ?? {});
  if (!data || !nodes.length) throw new HtmlCaptureError("unsupported_type", "На странице ChatGPT не найден сохранённый разговор: возможно, ссылка удалена или формат страницы изменился.");
  const messages: Message[] = [];
  let canvas: Textdoc | null = null;
  for (const node of nodes) {
    const message = obj(obj(node)?.message);
    if (!message) continue;
    const role = obj(message.author)?.role;
    const content = obj(message.content);
    const metadata = obj(message.metadata) ?? {};
    if (!content || metadata.is_visually_hidden_from_conversation) continue;
    // A canvas the model created in this conversation (canmore). A later update
    // is a patch this page cannot replay, so an updated canvas is not taken.
    const recipient = String(message.recipient ?? "all");
    if (role === "assistant" && recipient.startsWith("canmore.")) {
      if (recipient === "canmore.create_textdoc") {
        try {
          canvas = textdoc(JSON.parse(String(content.text ?? "")));
        } catch {
          canvas = null;
        }
      } else if (recipient === "canmore.update_textdoc") canvas = null;
      continue;
    }
    if ((role !== "user" && role !== "assistant") || recipient !== "all") continue;
    const parts = Array.isArray(content.parts) ? content.parts.filter((part: unknown): part is string => typeof part === "string") : [];
    const text = (parts.length ? parts.join("\n") : typeof content.text === "string" ? content.text : "").trim();
    if (text) messages.push({ role, text });
  }
  return { title: String(data.title ?? "").trim() || pageTitle, canvas, messages };
}

/** Fenced code blocks of a Markdown reply, in order. */
export function codeBlocks(markdown: string): Array<{ language: string | null; source: string }> {
  const blocks: Array<{ language: string | null; source: string }> = [];
  const fence = /^(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
  for (const match of markdown.matchAll(fence)) blocks.push({ language: match[2] || null, source: match[3] });
  return blocks;
}

const CANVAS_LANGUAGE: Record<string, string> = { "code/react": "jsx", "code/html": "html", document: "markdown" };

/** What to save from a page, with the reason in words for the warning line. */
export function chatgptWork(content: ChatgptContent): { title: string; body: SourceBody; what: string } {
  const title = (content.title || "Чат ChatGPT").slice(0, MAX_TITLE);
  if (content.canvas) {
    const doc = content.canvas;
    const language = CANVAS_LANGUAGE[doc.type] ?? doc.type.replace(/^code\//, "");
    const name = (doc.title || title).slice(0, MAX_TITLE);
    return { title: name, body: sourceBody(name, doc.content, language), what: "canvas" };
  }
  const last = [...content.messages].reverse().find((message) => message.role === "assistant");
  if (last) {
    const blocks = codeBlocks(last.text).reverse();
    for (const block of blocks) {
      const body = sourceBody(title, block.source, block.language);
      // Only a page, a component or a picture is a work; other code stays part of the conversation.
      const kind = "component" in body ? "component" : /^\s*<!doctype html>\s*<html lang="ru">[\s\S]*<pre>/i.test(body.html) ? "text" : "page";
      if (kind !== "text") return { title, body, what: "code" };
    }
  }
  const sections = content.messages
    .map(
      (message) =>
        `<section class="${message.role}"><h2>${message.role === "user" ? "Пользователь" : "ChatGPT"}</h2><div class="text">${escapeHtml(message.text)}</div></section>`,
    )
    .join("\n");
  return {
    title,
    what: "conversation",
    body: {
      html: simplePage(
        title,
        `<h1>${escapeHtml(title)}</h1>\n${sections}`,
        "body{max-width:820px;margin:0 auto}h1{font-size:24px}section{margin:20px 0;padding:16px 18px;border-radius:12px}section.user{background:#f3f4f6}section.assistant{border:1px solid #e5e7eb}h2{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280}.text{white-space:pre-wrap;overflow-wrap:anywhere}",
      ),
    },
  };
}

const WHAT: Record<string, string> = {
  canvas: "Сохранён canvas из ChatGPT.",
  code: "Сохранён код из последнего ответа ChatGPT.",
  conversation: "В разговоре нет страницы или компонента: сохранён сам разговор текстом.",
};

export type ChatgptOptions = { fetch?: FetchCall; fetcher?: Fetcher; onFetching?: () => Promise<void>; signal?: AbortSignal };

export async function captureChatgpt(input: string, { fetch = rendererFetchClient(), fetcher = fetchPublic, onFetching, signal }: ChatgptOptions = {}) {
  const target = publicUrl(input);
  if (!fetchable(target)) throw new HtmlCaptureError("not_allowed", "Эту страницу ChatGPT Полка не открывает.");
  await onFetching?.();
  let answer: FetchResult;
  try {
    answer = await fetch(target.href, signal);
  } catch {
    throw rendererUnavailable();
  }
  if ("error" in answer) throw rendererFailure(answer.error, answer.detail);
  const work = chatgptWork(parseChatgpt(answer.html));
  const source = new URL(answer.finalUrl);
  source.search = "";
  source.hash = "";
  const warnings = [WHAT[work.what]];
  if ("html" in work.body)
    return captureHtmlDocument(
      { url: source.href, contentType: "text/html", bytes: Buffer.from(work.body.html, "utf8") },
      { fetcher, signal, warnings, title: work.title, sourceUrl: source.href },
    );
  return componentCapture(work.title, work.body, source.href, warnings);
}

/** A React component as publishFromAgent saves it: a shell page and the module, built by the runtime. */
async function componentCapture(title: string, body: Extract<SourceBody, { component: string }>, sourceUrl: string, warnings: string[]) {
  if (!config.HTML_LIVE_ENABLED) {
    const code = sourceBody(title, body.component, "text");
    return captureHtmlDocument(
      { url: sourceUrl, contentType: "text/html", bytes: Buffer.from("html" in code ? code.html : "", "utf8") },
      { fetcher: fetchPublic, warnings: [...warnings, "Интерактивный просмотр на этой установке выключен: React-компонент сохранён как код."], title, sourceUrl },
    );
  }
  const file = body.componentLanguage === "tsx" ? "App.tsx" : "App.jsx";
  const files = [
    { path: "index.html", mime: "text/html", bytes: Buffer.from(componentShell(title, file), "utf8") },
    { path: file, mime: "text/javascript", bytes: Buffer.from(body.component, "utf8") },
  ];
  const manifest = canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    runtime: "static-sandbox-v1",
    files: files.map((f) => ({ path: f.path, mime: f.mime, size: f.bytes.length, sha256: createHash("sha256").update(f.bytes).digest("hex") })),
    provenance: { kind: "url", sourceUrl, capturedAt: new Date().toISOString(), attribution: "Imported from a public URL by the user", license: "unknown" },
    dependencies: { status: "unknown", unresolved: [] },
  });
  const built = await checkBuildInWorker(manifest, files.map((f) => ({ path: f.path, bytes: f.bytes })));
  const found = built.ok ? (built.warnings ?? []).map((warning) => `В интерактивной версии: ${warning}`) : [`Интерактивная сборка недоступна: ${built.reason}`];
  return {
    title,
    manifest,
    files: files.map((f) => ({ path: f.path, encoding: "base64" as const, data: f.bytes.toString("base64") })),
    previewReady: built.ok && found.length === 0,
    warnings: [...warnings, ...found],
  };
}
