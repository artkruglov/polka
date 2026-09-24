import { linkDocumentSchema, type LinkDocument } from "../../packages/contracts/index.ts";
import { matchLink, type LinkProviderId } from "../../packages/contracts/link-providers.ts";

/*
 * How a link work is stored (docs/specs/SAVED_LINKS.md): one small JSON file
 * {v:1,url,note} with mime LINK_MIME, named «<host>.link.json». The name
 * carries the host so the shelf can show host and service badge without
 * reading the file; the URL itself is only in the file.
 */

/** The host a link is shown under: a known service's own host (g.co/gemini → gemini.google.com). */
export function linkHost(url: URL): string {
  const match = matchLink(url);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return match?.provider?.hosts.includes(host) || !match?.provider?.hosts.length ? host : match.provider.hosts[0];
}

export const linkFilename = (url: URL) => `${linkHost(url)}.link.json`;

export function linkOfRevision(filename: string): { host: string; service: LinkProviderId | null } {
  const host = filename.replace(/\.link\.json$/, "");
  return { host, service: matchLink(`https://${host}/`)?.provider?.id ?? null };
}

export function linkDocumentBytes(url: URL, note: string | null): Buffer {
  const document: LinkDocument = { v: 1, url: url.href, note: note || null };
  return Buffer.from(JSON.stringify(linkDocumentSchema.parse(document)));
}

export function readLinkDocument(bytes: Buffer): LinkDocument {
  return linkDocumentSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/** What the content filter reads of a link work: title, address and note. */
export function linkText(title: string, bytes: Buffer): string {
  const document = readLinkDocument(bytes);
  return [title, document.url, document.note ?? ""].join("\n");
}
