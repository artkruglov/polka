// The project viewer (docs/specs/PROJECTS.md) on the viewer domain:
// GET /project/:token/<path> serves one file of a pinned project version.
// The token is in the path, so a page's relative addresses (its CSS, fonts,
// pictures, the next document) resolve to the same project by themselves.
//
// A document (Markdown, a page, a picture, text) is served only into a frame
// of the app (Fetch Metadata iframe + navigate), like /static and /document.
// A resource is served only to a page of the project asking for that kind of
// resource (style, script, image, font), never as a page. Markdown is drawn by
// Полка (project-markdown.ts). A page runs in a sandbox without the viewer's
// origin, network, popups or top navigation; the only scripts Полка adds are
// the WebRTC guard (html.ts, VIEWER_GUARD) and nav.js, which tells the app
// which page is open.
import { createHash, randomBytes } from "node:crypto";
import { answeringAccountSql, linkShelfOpenSql } from "./owner-state.ts";
import { posix } from "node:path";
import type { FastifyInstance } from "fastify";
import { PROJECT_RUNTIME } from "../../packages/contracts/bundle.ts";
import { isVideoMime } from "../../packages/contracts/constants.ts";
import type { Actor } from "./artifacts.ts";
import { withSignedAwayLinks } from "./away-links.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { assertEditorialShareAccessible } from "./editorial.ts";
import { missing } from "./errors.ts";
import { VIEWER_GUARD, withLeadingMarkup } from "./html.ts";
import {
  escapeHtml,
  projectDocumentPage,
  renderProjectMarkdownBounded,
} from "./project-markdown.ts";
import { readBlob, readStream, sha256 } from "./storage.ts";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const projectHash = (token: string) => sha256(`project-view:${token}`);
export const PROJECT_VIEW_MINUTES = 30;
const NAV_SCRIPT = "__polka/nav.js";

const PROJECT_REVISION_SQL = `r.storage_kind='bundle' AND r.manifest->>'runtime'='${PROJECT_RUNTIME}'`;

const base = (token: string) => `${config.VIEWER_ORIGIN}/project/${token}/`;
const viewResult = (token: string, expiresAt: Date) => ({
  url: base(token),
  expiresAt: expiresAt.toISOString(),
});

export async function issueOwnerProjectView(
  actor: Actor,
  sessionToken: string,
  revisionId: string,
) {
  if (!config.HTML_LIVE_ENABLED) throw missing();
  const token = randomBytes(32).toString("base64url");
  const grant = await transaction(async (c) => {
    await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR SHARE", [actor.tenant]);
    return (
      await c.query(
        `INSERT INTO project_view_grants(hash,revision_id,owner_session_hash,expires_at)
         SELECT $1,r.id,session.hash,
           LEAST(now()+make_interval(mins=>$6),session.expires_at)
         FROM revisions r
         JOIN artifacts artifact ON artifact.id=r.artifact_id
           AND artifact.tenant_id=r.tenant_id AND artifact.trashed_at IS NULL
         JOIN tenants tenant ON tenant.id=r.tenant_id
         JOIN sessions session ON session.hash=$2 AND session.account_id=$3
         JOIN accounts account ON account.id=session.account_id
           AND tenant.state='active'
         JOIN tenant_members member ON member.tenant_id=tenant.id
           AND member.account_id=account.id AND member.state='active'
         WHERE r.id=$4 AND r.tenant_id=$5 AND ${PROJECT_REVISION_SQL}
           AND session.expires_at>now() AND NOT account.disabled
           AND account.deletion_requested_at IS NULL
         RETURNING expires_at`,
        [projectHash(token), sha256(sessionToken), actor.id, revisionId, actor.tenant, PROJECT_VIEW_MINUTES],
      )
    ).rows[0];
  });
  if (!grant) throw missing();
  return viewResult(token, grant.expires_at);
}

/** A recipient's view from a fresh /api/resolve grant; it then follows the link. */
export async function issueRecipientProjectView(sourceGrant: string) {
  if (!config.HTML_LIVE_ENABLED || !TOKEN.test(sourceGrant)) throw missing();
  const token = randomBytes(32).toString("base64url");
  const grant = await transaction(async (c) => {
    const candidate = (
      await c.query(
        `SELECT s.id AS share_id,s.tenant_id,s.artifact_id
         FROM grants g JOIN shares s ON s.id=g.share_id WHERE g.hash=$1`,
        [sha256(sourceGrant)],
      )
    ).rows[0];
    if (!candidate) throw missing();
    await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR SHARE", [candidate.tenant_id]);
    await c.query("SELECT 1 FROM shares WHERE id=$1 FOR SHARE", [candidate.share_id]);
    await assertEditorialShareAccessible(c, candidate.share_id);
    return (
      await c.query(
        `INSERT INTO project_view_grants(hash,revision_id,share_id,expires_at)
         SELECT $1,r.id,s.id,LEAST(now()+make_interval(mins=>$3),s.expires_at)
         FROM grants g
         JOIN shares s ON s.id=g.share_id
         JOIN revisions r ON r.id=g.revision_id AND r.id=s.revision_id
         JOIN artifacts artifact ON artifact.id=r.artifact_id
           AND artifact.id=s.artifact_id AND artifact.trashed_at IS NULL
         JOIN tenants tenant ON tenant.id=s.tenant_id
         JOIN accounts account ON account.id=${answeringAccountSql("tenant", "s")}
           AND ${linkShelfOpenSql("tenant")}
         WHERE g.hash=$2 AND g.expires_at>now()
           AND NOT s.revoked AND s.expires_at>now() AND s.moderation='none'
           AND NOT account.disabled AND account.deletion_requested_at IS NULL
           AND ${PROJECT_REVISION_SQL}
         RETURNING expires_at`,
        [projectHash(token), sha256(sourceGrant), PROJECT_VIEW_MINUTES],
      )
    ).rows[0];
  });
  if (!grant) throw missing();
  return viewResult(token, grant.expires_at);
}

/** Every read rechecks trash, logout, revoke, the link's expiry and the owner. */
async function authorizedProject(token: string) {
  if (!config.HTML_LIVE_ENABLED || !TOKEN.test(token)) return null;
  const {
    rows: [revision],
  } = await db.query(
    `SELECT r.id,r.manifest,pv.share_id,pv.owner_session_hash FROM project_view_grants pv
     JOIN revisions r ON r.id=pv.revision_id
     JOIN artifacts artifact ON artifact.id=r.artifact_id AND artifact.trashed_at IS NULL
     JOIN tenants tenant ON tenant.id=r.tenant_id AND tenant.state='active'
       AND ($2::boolean OR tenant.kind='personal')
     WHERE pv.hash=$1 AND pv.expires_at>now() AND ${PROJECT_REVISION_SQL}
       AND r.content_purged_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM moderation_blocks b
                       WHERE b.revision_id=r.id AND b.released_at IS NULL)
       AND (
         (pv.owner_session_hash IS NOT NULL AND EXISTS (
           SELECT 1 FROM sessions session
           JOIN accounts account ON account.id=session.account_id
           JOIN tenant_members member ON member.account_id=account.id
             AND member.tenant_id=tenant.id AND member.state='active'
           WHERE session.hash=pv.owner_session_hash AND session.expires_at>now()
             AND NOT account.disabled AND account.deletion_requested_at IS NULL))
         OR
         (pv.share_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM shares s
           JOIN accounts owner ON owner.id=${answeringAccountSql("tenant", "s")}
             AND ${linkShelfOpenSql("tenant")}
           WHERE s.id=pv.share_id AND s.revision_id=r.id AND s.artifact_id=artifact.id
             AND NOT owner.disabled AND owner.deletion_requested_at IS NULL
             AND NOT s.revoked AND s.expires_at>now() AND s.moderation='none'))
       )`,
    [projectHash(token), config.TEAM_SHELVES === "on"],
  );
  // A link withdrawn from the feed closes with it, like /static and /document.
  if (revision?.share_id) await assertEditorialShareAccessible(db, revision.share_id);
  return revision ?? null;
}

/**
 * A new view from a live one, for a reader still on the project: the same
 * version and the same binding (the owner's session or the link), rechecked
 * like a read. A recipient's first grant lives 60 seconds, so a view is
 * renewed from itself, not from it.
 */
export async function renewProjectView(current: string) {
  const revision = await authorizedProject(current);
  if (!revision) throw missing();
  const token = randomBytes(32).toString("base64url");
  const {
    rows: [grant],
  } = await db.query(
    `INSERT INTO project_view_grants(hash,revision_id,owner_session_hash,share_id,expires_at)
     SELECT $1,$2,$3,$4,LEAST(now()+make_interval(mins=>$5),
       COALESCE((SELECT expires_at FROM sessions WHERE hash=$3),
                (SELECT expires_at FROM shares WHERE id=$4)))
     RETURNING expires_at`,
    [projectHash(token), revision.id, revision.owner_session_hash, revision.share_id, PROJECT_VIEW_MINUTES],
  );
  return viewResult(token, grant.expires_at);
}

/** The file a path names: itself, or a folder's index page or README. */
function fileAt(
  manifest: { entrypoint: string; files: Array<{ path: string; mime: string; size: number }> },
  raw: string,
) {
  const byPath = new Map(manifest.files.map((file) => [file.path, file]));
  const path = raw.replace(/\/+$/, "");
  if (!path) return byPath.get(manifest.entrypoint) ?? null;
  if (byPath.has(path)) return byPath.get(path)!;
  for (const index of ["README.md", "index.md", "index.html"]) {
    const inside = byPath.get(`${path}/${index}`);
    if (inside) return inside;
  }
  return null;
}

// What each kind of request may receive, by the Fetch Metadata destination.
const RESOURCE_FOR: Record<string, (mime: string) => boolean> = {
  style: (mime) => mime === "text/css",
  script: (mime) => mime === "text/javascript",
  image: (mime) => mime.startsWith("image/"),
  video: isVideoMime,
  font: (mime) => mime === "font/woff2",
};

export const pageCsp = (token: string) =>
  [
    // No allow-same-origin, allow-popups or top navigation: the page cannot
    // read the viewer, open a window or leave its frame.
    "sandbox allow-scripts allow-forms",
    "default-src 'none'",
    `script-src ${base(token)} 'unsafe-inline'`,
    `style-src ${base(token)} 'unsafe-inline'`,
    `img-src ${base(token)} data: blob:`,
    `font-src ${base(token)} data:`,
    `media-src ${base(token)} data:`,
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${config.APP_ORIGIN}`,
  ].join("; ");

const documentCsp = (token: string) =>
  [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${base(token)}${NAV_SCRIPT} ${GUARD_HASH}`,
    "style-src 'unsafe-inline'",
    `img-src ${base(token)}`,
    `media-src ${base(token)}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${config.APP_ORIGIN}`,
  ].join("; ");

/**
 * The byte range a `Range` header asks of a file of `size` bytes: one range
 * (`a-b`, `a-`, `-n`), as a player's seek sends it. Null when the header is
 * absent or not one range (the whole file is sent); "unsatisfiable" when it
 * lies beyond the file.
 */
export function parseRange(header: string | undefined, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const tail = Number(match[2]);
    if (tail === 0) return "unsatisfiable" as const;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "unsatisfiable" as const;
  return { start, end };
}

/**
 * Tells the app which page is open (for its tree), and hands it external
 * links: the sandbox has no popups, so the app opens the signed /away page.
 * The app treats both as hints from an untrusted frame.
 */
const navScript = () => `(() => {
  const root = location.pathname.split("/").slice(0, 3).join("/") + "/";
  const send = (message) => parent.postMessage(message, ${JSON.stringify(config.APP_ORIGIN)});
  const announce = () => send({ type: "polka-project-page", path: decodeURIComponent(location.pathname.slice(root.length)), hash: location.hash.slice(1), title: document.title });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce); else announce();
  addEventListener("hashchange", announce);
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (link && link.href.startsWith(${JSON.stringify(`${config.APP_ORIGIN}/away`)})) {
      event.preventDefault();
      send({ type: "polka-project-away", href: link.href });
    }
  }, true);
})();`;

/**
 * Полка's scripts first in a page, before anything of the author's: the
 * WebRTC guard (CSP cannot stop WebRTC, and a project page runs scripts),
 * then nav.js. They go at the very start of the document, after a leading
 * doctype only (html.ts, withLeadingMarkup), so no script of the page, not
 * even one before its <head>, runs earlier. The placement is a linear scan:
 * a regex looking for <head> is quadratic on a page of unclosed "<head"
 * tags, and this runs on every view.
 */
export function withProjectScripts(html: Buffer, token: string): Buffer {
  const tag = `<script src="${escapeHtml(base(token) + NAV_SCRIPT)}"></script>`;
  return withLeadingMarkup(html, Buffer.from(VIEWER_GUARD + tag));
}

/** The guard's hash: the documents' CSP runs no other inline script. */
const GUARD_HASH = `'sha256-${createHash("sha256")
  .update(VIEWER_GUARD.slice("<script>".length, -"</script>".length))
  .digest("base64")}'`;

const wrapperPage = (title: string, body: string, token: string) =>
  projectDocumentPage({ title, body }, base(token) + NAV_SCRIPT);

export function registerProjectViewerRoutes(viewer: FastifyInstance) {
  viewer.get("/project/:token/*", async (req, reply) => {
    const { token = "", "*": rawPath = "" } = req.params as { token?: string; "*"?: string };
    const dest = req.headers["sec-fetch-dest"];
    const navigate = dest === "iframe" && req.headers["sec-fetch-mode"] === "navigate";
    const path = posix.normalize(rawPath || ".").replace(/^\.$/, "");
    if (path.startsWith("..") || path.includes("\\")) throw missing();
    const revision = await authorizedProject(token);
    if (!revision) throw missing();
    if (path === NAV_SCRIPT) {
      if (dest !== "script") throw missing();
      return reply.type("text/javascript; charset=utf-8").send(navScript());
    }
    const file = fileAt(revision.manifest, path);
    if (!file) throw missing();
    // A folder's address opens its page at its own path, so relative links work.
    if (navigate && file.path !== path && (rawPath !== "" || file.path.includes("/")))
      return reply.redirect(base(token) + file.path.split("/").map(encodeURIComponent).join("/"), 303);
    const stored = (
      await db.query(
        "SELECT object_key,object_version FROM revision_files WHERE revision_id=$1 AND path=$2",
        [revision.id, file.path],
      )
    ).rows[0];
    if (!stored) throw missing();
    if (isVideoMime(file.mime) && !navigate) {
      // Some engines send no Fetch Metadata for a media request; the token
      // in the path is the permission, and a video runs no script.
      if (dest !== "video" && dest !== undefined) throw missing();
      // A player asks for the file in ranges as it plays and seeks: only
      // those bytes are read from the store, never the whole file.
      const range = parseRange(req.headers.range, file.size);
      if (range === "unsatisfiable")
        return reply.status(416).header("content-range", `bytes */${file.size}`).send();
      // Idle for a while when the player has buffered enough and waits.
      if (typeof req.raw.socket?.setTimeout === "function") req.raw.socket.setTimeout(10 * 60 * 1000);
      const body = await readStream(stored.object_key, stored.object_version, range ?? undefined);
      reply.type(file.mime).header("accept-ranges", "bytes");
      if (!range) return reply.header("content-length", file.size).send(body);
      return reply
        .status(206)
        .header("content-range", `bytes ${range.start}-${range.end}/${file.size}`)
        .header("content-length", range.end - range.start + 1)
        .send(body);
    }
    const bytes = isVideoMime(file.mime)
      ? Buffer.alloc(0)
      : await readBlob(stored.object_key, stored.object_version);
    if (!navigate) {
      const allowed = typeof dest === "string" ? RESOURCE_FOR[dest] : undefined;
      if (!allowed?.(file.mime)) throw missing();
      // Fonts and module scripts are fetched in CORS mode, and a sandboxed
      // page's origin is "null". The token in the path is the permission;
      // the header adds no reader who could not already load these bytes.
      if (dest === "font" || dest === "script")
        reply.header("access-control-allow-origin", "*");
      return reply.type(file.mime).send(bytes);
    }
    const name = posix.basename(file.path);
    if (file.mime === "text/html") {
      const page = withSignedAwayLinks(bytes, base(token) + file.path);
      return reply
        .type("text/html; charset=utf-8")
        .header("content-security-policy", pageCsp(token))
        .send(withProjectScripts(page, token));
    }
    const paths = new Set<string>(revision.manifest.files.map((f: { path: string }) => f.path));
    const body =
      file.mime === "text/markdown"
        ? projectDocumentPage(
            await renderProjectMarkdownBounded(
              bytes.toString("utf8"),
              file.path,
              paths,
              `${revision.id}:${file.path}`,
            ),
            base(token) + NAV_SCRIPT,
          )
        : isVideoMime(file.mime)
          ? wrapperPage(
              name,
              `<h1>${escapeHtml(name)}</h1><video controls preload="metadata" style="max-width:100%" src="${escapeHtml(encodeURIComponent(name))}"></video>`,
              token,
            )
        : file.mime.startsWith("image/")
          ? wrapperPage(name, `<h1>${escapeHtml(name)}</h1><img src="${escapeHtml(encodeURIComponent(name))}" alt="">`, token)
          : wrapperPage(name, `<h1>${escapeHtml(name)}</h1><pre><code>${escapeHtml(bytes.toString("utf8"))}</code></pre>`, token);
    return reply
      .type("text/html; charset=utf-8")
      .header("content-security-policy", documentCsp(token))
      // Полка draws these and runs no script of the author's in them, but
      // every HTML response of the project starts with the guard.
      .send(withLeadingMarkup(Buffer.from(body), Buffer.from(VIEWER_GUARD)));
  });
}
