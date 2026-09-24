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
    const html = page.bytes.toString("utf8");
    const raw =
      /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']{1,300})["']/i.exec(html)?.[1] ??
      /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html)?.[1];
    const title = raw ? decodeHTML(raw).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
    return title || null;
  } catch {
    return null;
  }
};

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
