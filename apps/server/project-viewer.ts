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
// origin, network, popups or top navigation; the only script Полка adds is
// nav.js, which tells the app which page is open.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { FastifyInstance } from "fastify";
import { PROJECT_RUNTIME } from "../../packages/contracts/bundle.ts";
import type { Actor } from "./artifacts.ts";
import { withSignedAwayLinks } from "./away-links.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { missing } from "./errors.ts";
import {
  escapeHtml,
  projectDocumentPage,
  renderProjectMarkdown,
} from "./project-markdown.ts";
import { readBlob, sha256 } from "./storage.ts";

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
           AND account.id=tenant.owner_id
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
         JOIN accounts account ON account.id=tenant.owner_id
         WHERE g.hash=$2 AND g.expires_at>now()
           AND NOT s.revoked AND s.expires_at>now()
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
    `SELECT r.id,r.manifest FROM project_view_grants pv
     JOIN revisions r ON r.id=pv.revision_id
     JOIN artifacts artifact ON artifact.id=r.artifact_id AND artifact.trashed_at IS NULL
     JOIN tenants tenant ON tenant.id=r.tenant_id
     JOIN accounts owner ON owner.id=tenant.owner_id
     WHERE pv.hash=$1 AND pv.expires_at>now() AND ${PROJECT_REVISION_SQL}
       AND NOT owner.disabled AND owner.deletion_requested_at IS NULL
       AND r.content_purged_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM moderation_blocks b
                       WHERE b.revision_id=r.id AND b.released_at IS NULL)
       AND (
         (pv.owner_session_hash IS NOT NULL AND EXISTS (
           SELECT 1 FROM sessions session
           WHERE session.hash=pv.owner_session_hash AND session.account_id=owner.id
             AND session.expires_at>now()))
         OR
         (pv.share_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM shares s
           WHERE s.id=pv.share_id AND s.revision_id=r.id AND s.artifact_id=artifact.id
             AND NOT s.revoked AND s.expires_at>now()))
       )`,
    [projectHash(token)],
  );
  return revision ?? null;
}

/** The file a path names: itself, or a folder's index page or README. */
function fileAt(manifest: { entrypoint: string; files: Array<{ path: string; mime: string }> }, raw: string) {
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
  font: (mime) => mime === "font/woff2",
};

const pageCsp = (token: string) =>
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
    `script-src ${base(token)}${NAV_SCRIPT}`,
    "style-src 'unsafe-inline'",
    `img-src ${base(token)}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${config.APP_ORIGIN}`,
  ].join("; ");

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

/** Polka's script first in the page's head, before any of the author's. */
function withNavScript(html: string, token: string) {
  const tag = `<script src="${escapeHtml(base(token) + NAV_SCRIPT)}"></script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html;
}

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
    if (navigate && file.path !== path && rawPath !== "")
      return reply.redirect(base(token) + file.path.split("/").map(encodeURIComponent).join("/"), 303);
    const stored = (
      await db.query(
        "SELECT object_key,object_version FROM revision_files WHERE revision_id=$1 AND path=$2",
        [revision.id, file.path],
      )
    ).rows[0];
    if (!stored) throw missing();
    const bytes = await readBlob(stored.object_key, stored.object_version);
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
      const page = withSignedAwayLinks(bytes, base(token) + file.path).toString("utf8");
      return reply
        .type("text/html; charset=utf-8")
        .header("content-security-policy", pageCsp(token))
        .send(withNavScript(page, token));
    }
    const paths = new Set<string>(revision.manifest.files.map((f: { path: string }) => f.path));
    const body =
      file.mime === "text/markdown"
        ? projectDocumentPage(
            renderProjectMarkdown(bytes.toString("utf8"), file.path, paths),
            base(token) + NAV_SCRIPT,
          )
        : file.mime.startsWith("image/")
          ? wrapperPage(name, `<h1>${escapeHtml(name)}</h1><img src="${escapeHtml(encodeURIComponent(name))}" alt="">`, token)
          : wrapperPage(name, `<h1>${escapeHtml(name)}</h1><pre><code>${escapeHtml(bytes.toString("utf8"))}</code></pre>`, token);
    return reply
      .type("text/html; charset=utf-8")
      .header("content-security-policy", documentCsp(token))
      .send(body);
  });
}
