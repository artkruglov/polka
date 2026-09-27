import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { decodeHTML } from "entities";
import {
  LINK_MIME,
  MAX_TITLE,
  saveLinkSchema,
  savedLinkUrl,
  type SaveLinkInput,
} from "../../packages/contracts/index.ts";
import { defaultLinkTitle, matchLink } from "../../packages/contracts/link-providers.ts";
import { RENDERER_USER_AGENT } from "../../packages/renderer-contract.ts";
import {
  beginUploadInTransaction,
  finalizeUploadInTransaction,
  uploadBytesInTransaction,
  type Actor,
} from "./artifacts.ts";
import { config } from "./config.ts";
import { transaction } from "./db.ts";
import { withServiceActorTransaction, type ServiceActor } from "./service-auth.ts";
import { linkDocumentBytes, linkFilename } from "./saved-link-format.ts";
import { fetchPublic } from "./url-import/public-fetch.ts";
import { robotsAllow, robotsFor } from "./url-import/robots.ts";

/*
 * «Сохранить как ссылку» (docs/specs/SAVED_LINKS.md): a work that keeps a link
 * as it is, for anything Полка cannot or may not copy (Claude, ChatGPT, a page
 * behind a bot check, a failed import). One small file {v:1,url,note}, saved
 * through the ordinary single-file path, so quota, audit, the content filter
 * (title, address — and the listed domains in it — and note) and moderation
 * at sharing are the same as for any work.
 *
 * The server never opens an AI chat's link (Claude, ChatGPT, v0, Perplexity,
 * AI Studio, Gemini) for its title. For other https links, when
 * the owner gave no title and import by link is enabled here, it may read the
 * page's <title> once, as PolkaRenderer, if robots.txt allows.
 */

type PageTitle = (url: URL) => Promise<string | null>;

export const pageTitle: PageTitle = async (url) => {
  const match = matchLink(url);
  // Only ordinary sites and published SPA hosts: AI chats (Claude, ChatGPT…) and gists are never read for a title.
  if (!config.URL_IMPORT_ENABLED || !match || !(match.route === "html" || match.route === "server-render") || match.provider?.id === "gemini" || match.closed) return null;
  try {
    const robots = await robotsFor(url);
    if (!robotsAllow(robots, url)) return null;
    const page = await fetchPublic(url.href, {
      maxBytes: 512 * 1024,
      timeoutMs: 5_000,
      accept: "text/html",
      userAgent: RENDERER_USER_AGENT,
    });
    if (!/^text\/html/i.test(page.contentType)) return null;
    return readPageTitle(page.bytes.subarray(0, TITLE_SCAN_BYTES).toString("utf8"));
  } catch {
    return null;
  }
};

/** Where a page's titles are looked for: real ones are near the top. */
export const TITLE_SCAN_BYTES = 32 * 1024;
const isSpace = (c: number) => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const startsWithCi = (text: string, at: number, lower: string) =>
  text.slice(at, at + lower.length).toLowerCase() === lower;
const OG_TITLE = /property=["']og:title["']/gi;
const CONTENT = /content=["']([^"']{1,300})["']/gi;

/**
 * The page's og:title, else its <title>, decoded and on one line; null when
 * it has neither. Read from the first 32 KB by a hand-written scan, linear in
 * that: this runs on the server's request thread over whatever the address
 * serves, and regexes like /<meta[^>]+…[^>]*content=…/ over the whole page
 * rescan it from every "<meta" (32 KB took 7 s). The two regexes left run
 * inside one tag each and have no unbounded part that can backtrack.
 */
export function readPageTitle(source: string): string | null {
  const text = source.length > TITLE_SCAN_BYTES ? source.slice(0, TITLE_SCAN_BYTES) : source;
  let og: string | undefined;
  let plain: string | undefined;
  for (let lt = text.indexOf("<"); lt !== -1 && og === undefined; lt = text.indexOf("<", lt + 1)) {
    if (startsWithCi(text, lt + 1, "meta") && isSpace(text.charCodeAt(lt + 5))) {
      const end = text.indexOf(">", lt);
      if (end === -1) break;
      const tag = text.slice(lt, end);
      OG_TITLE.lastIndex = 0;
      if (OG_TITLE.exec(tag)) {
        CONTENT.lastIndex = OG_TITLE.lastIndex;
        og = CONTENT.exec(tag)?.[1];
      }
      lt = end;
    } else if (
      plain === undefined &&
      startsWithCi(text, lt + 1, "title") &&
      (isSpace(text.charCodeAt(lt + 6)) || text[lt + 6] === ">" || text[lt + 6] === "/")
    ) {
      const open = text.indexOf(">", lt + 6);
      if (open === -1) break;
      const close = text.indexOf("<", open + 1);
      if (close === -1) break;
      const length = close - open - 1;
      if (length >= 1 && length <= 300 && startsWithCi(text, close, "</title>"))
        plain = text.slice(open + 1, close);
      lt = close - 1;
    }
  }
  const raw = og ?? plain;
  const title = raw ? decodeHTML(raw).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
  return title || null;
}

type Prepared = { input: SaveLinkInput; url: URL; title: string; bytes: Buffer };

async function prepare(body: unknown, title: PageTitle): Promise<Prepared> {
  const input = saveLinkSchema.parse(body);
  const url = savedLinkUrl(input.url)!;
  const chosen = input.title ?? (url.protocol === "https:" ? await title(url) : null) ?? defaultLinkTitle(url);
  return { input, url, title: chosen, bytes: linkDocumentBytes(url, input.note ?? null) };
}

async function saveInTransaction(c: PoolClient, actor: Actor, { input, url, title, bytes }: Prepared) {
  const begun = await beginUploadInTransaction(c, actor, {
    key: input.key,
    title,
    filename: linkFilename(url),
    mime: LINK_MIME,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
  });
  if (!begun.receipt) await uploadBytesInTransaction(c, actor, begun.uploadId, bytes);
  const receipt = begun.receipt ?? (await finalizeUploadInTransaction(c, actor, begun.uploadId));
  return { ...receipt, title, url: url.href, link: true as const };
}

/** The owner in the browser (POST /api/links). */
export async function saveLink(actor: Actor, body: unknown, { title = pageTitle }: { title?: PageTitle } = {}) {
  const prepared = await prepare(body, title);
  return transaction((c) => saveInTransaction(c, actor, prepared));
}

/** An agent over MCP (polka_save_link), with the capture scope. */
export async function saveLinkFromAgent(actor: ServiceActor, body: unknown, { title = pageTitle }: { title?: PageTitle } = {}) {
  const prepared = await prepare(body, title);
  return withServiceActorTransaction(actor, "capture", (c, verified) =>
    saveInTransaction(c, { id: verified.accountId, tenant: verified.tenantId, connectionId: verified.connectionId }, prepared),
  );
}
