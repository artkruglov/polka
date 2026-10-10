import { setShareFollowMode } from "./share-follow.ts";
import { checkLinkOpen, extensions } from "./extensions.ts";
import { trackShareOpened } from "./analytics.ts";
import { z } from "zod";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { identity, limitAttempts } from "./auth.ts";
import { Problem, missing } from "./errors.ts";
import { issueShareGrant } from "./share-grants.ts";
import { STATIC_HTML_CSP, withNewTabLinks } from "./html.ts";
import { isStaticSingleFileBundle, staticSingleFileBundleSql } from "./revision-manifest.ts";
import { verifyAwayToken, withSignedAwayLinks } from "./away-links.ts";
import { issueOwnerStaticView, issueRecipientStaticView } from "./static-viewer.ts";
import { issueOwnerProjectView, issueRecipientProjectView, renewProjectView } from "./project-viewer.ts";
import { issueOwnerLiveView, issueRecipientLiveView } from "./live-viewer.ts";
import { exportRevision } from "./artifacts.ts";
import { readBlob, sha256 } from "./storage.ts";
import { buildInlineRevision, getInlineBuildStatus } from "./bundle-derivatives.ts";
import { SERVED_BUILDER_VERSIONS_SQL, SERVED_RUNTIME_PROFILES_SQL } from "./bundle-runtime-contract.ts";
import { coverFor, coverImage } from "./covers.ts";
import { enableOwnerShare, publishOwnerShare, revokeOwnerShare } from "./shares.ts";
import { assertEditorialShareAccessible } from "./editorial.ts";
import { answeringAccountSql, linkShelfOpenSql, lockAnsweringAccount } from "./owner-state.ts";
import type { FastifyInstance } from "fastify";
import { SHELF, id, strongIdentity, withComments } from "./route-helpers.ts";

/** Share resolutions per client IP per 10 minutes; each view resolves once per grant. */
export const RESOLVE_LIMIT_PER_IP = 600;
/** Opening saved versions: bytes, covers, exports, views for the owner and recipients, links. */
export function registerViewRoutes(app: FastifyInstance) {
  // Owner download and export stay available in the trash (docs/TRASH_SPEC.md:
  // R17 export); only /document, which renders the page, refuses a trashed one.
  app.get("/api/revisions/:id/bytes", async (req, reply) => {
    const actor = await identity(req, SHELF);
    const {
      rows: [r],
    } = await db.query("SELECT * FROM revisions WHERE id=$1 AND tenant_id=$2", [id(req), actor.tenant]);
    if (!r) throw missing();
    reply
      .type(r.mime)
      .header("content-security-policy", "sandbox; default-src 'none'")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`);
    return readBlob(r.object_key, r.object_version);
  });
  // Shelf covers (docs/specs/SHELF_COVERS.md). The card asks for the cover
  // once per version; the picture is immutable for its key, so the browser
  // keeps it (private: it is the owner's content).
  app.get("/api/revisions/:id/cover", async (req) => ({
    cover: await coverFor(await identity(req, SHELF), id(req)),
  }));
  app.get("/api/revisions/:id/cover.jpg", async (req, reply) => {
    const image = await coverImage(await identity(req, SHELF), id(req));
    reply
      .type(image.type)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .header("cross-origin-resource-policy", "same-origin");
    return image.bytes;
  });
  app.get("/api/revisions/:id/export", async (req, reply) => {
    const revisionId = id(req);
    const result = await exportRevision(await identity(req, SHELF), revisionId);
    reply
      .type("application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename*=UTF-8''${revisionId}.polka-bundle.json`);
    return result;
  });
  app.get("/api/revisions/:id/build-inline", async (req) => getInlineBuildStatus(await identity(req, SHELF), id(req)));
  app.post("/api/revisions/:id/build-inline", async (req, reply) => {
    const result = await buildInlineRevision(await identity(req, SHELF), id(req));
    if (result.concurrent) reply.code(202);
    return result.status;
  });
  // Only a single-domain install (no viewer) shows saved HTML on the app
  // origin; with a viewer the static view is served there (static-viewer.ts)
  // and these routes answer 404. Even here the page never runs as the app:
  // the response itself carries a sandbox CSP, so even a direct navigation
  // runs no scripts and has no network.
  // A browser that says it is opening the page top-level is refused too: the
  // page belongs inside Полка's frame, and on its own at a Полка URL it could
  // pose as a Полка screen. Browsers without Fetch Metadata still get the frame.
  const sendHtml = async (req: any, reply: any, r: any) => {
    if (config.HTML_LIVE_ENABLED) throw missing();
    if (req.headers["sec-fetch-dest"] === "document") throw missing();
    if (
      !r ||
      r.mime !== "text/html" ||
      r.html_profile === "unsupported" ||
      (r.storage_kind === "bundle" && !isStaticSingleFileBundle(r))
    )
      throw missing();
    reply
      .type("text/html; charset=utf-8")
      .header("content-security-policy", STATIC_HTML_CSP)
      .header("cross-origin-resource-policy", "same-origin");
    return withNewTabLinks(
      withSignedAwayLinks(await readBlob(r.object_key, r.object_version), new URL(req.url, config.APP_ORIGIN).href),
    );
  };
  // Where the static frame loads from: the viewer (a 60-second grant) when
  // there is one, else the app routes below. The web app asks here first.
  app.post("/api/revisions/:id/static-view", async (req) => {
    const actor = await identity(req, SHELF);
    const revisionId = id(req);
    if (!config.HTML_LIVE_ENABLED) return { url: `/api/revisions/${revisionId}/document` };
    return issueOwnerStaticView(actor, req.cookies.polka_session ?? "", revisionId, withComments(req));
  });
  // Projects (docs/specs/PROJECTS.md): a view of the whole folder, page by page.
  app.post("/api/revisions/:id/project-view", async (req) => {
    const actor = await identity(req, SHELF);
    return issueOwnerProjectView(actor, req.cookies.polka_session ?? "", id(req));
  });
  app.post("/api/view/project-view/renew", async (req) => {
    const { token } = z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(req.body);
    return renewProjectView(token);
  });
  app.post("/api/view/project-view", async (req) => {
    const grant = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    return issueRecipientProjectView(grant);
  });
  app.post("/api/view/static-view", async (req) => {
    const grant = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (config.HTML_LIVE_ENABLED) return issueRecipientStaticView(grant, withComments(req));
    if (!/^[A-Za-z0-9_-]{43}$/.test(grant)) throw missing();
    return { url: `/api/view/${grant}/document` };
  });
  // The "you are leaving Полка" page asks what a signed link points to. It
  // never redirects: the page names the address and the reader clicks.
  app.post("/api/away", { bodyLimit: 32 * 1024 }, async (req) => {
    const { token } = z
      .object({ token: z.string().max(20000) })
      .strict()
      .parse(req.body);
    const target = verifyAwayToken(token);
    if (!target)
      throw new Problem(
        404,
        "not_found",
        "Ссылка устарела или повреждена. Полка открывает внешний адрес только по ссылке из страницы на Полке.",
      );
    return target;
  });
  app.get("/api/revisions/:id/document", async (req, reply) => {
    const actor = await identity(req, SHELF);
    const {
      rows: [r],
    } = await db.query("SELECT * FROM revisions WHERE id=$1 AND tenant_id=$2", [id(req), actor.tenant]);
    if (
      r &&
      !(
        await db.query("SELECT 1 FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL", [
          r.artifact_id,
          actor.tenant,
        ])
      ).rowCount
    )
      throw missing();
    return sendHtml(req, reply, r);
  });
  app.post("/api/revisions/:id/live-view", async (req) => {
    const actor = await identity(req, SHELF);
    return issueOwnerLiveView(actor, req.cookies.polka_session ?? "", id(req), withComments(req));
  });
  // Links follow the shelf: on a department shelf they are a curator's
  // (docs/specs/TEAM_SHELVES.md, stage 5).
  app.post("/api/artifacts/:id/share", async (req) => {
    return enableOwnerShare(await strongIdentity(req, SHELF), id(req), req.body);
  });
  app.post("/api/shares/:id/revoke", async (req) => {
    return revokeOwnerShare(await strongIdentity(req, SHELF), id(req));
  });
  // Whether an unattended agent may move this link to new versions.
  app.put("/api/shares/:id/follow", { bodyLimit: 1024 }, async (req) => {
    return setShareFollowMode(await strongIdentity(req, SHELF), id(req), req.body);
  });
  app.post("/api/shares/:id/publish", async (req) => {
    return publishOwnerShare(await strongIdentity(req, SHELF), id(req), req.body);
  });
  app.post("/api/resolve", async (req) => {
    const { token } = z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(req.body);
    await limitAttempts(`resolve:ip:${req.ip}`, RESOLVE_LIMIT_PER_IP);
    // The owner looking at their own link is not a recipient opening it.
    const viewerAccount = req.cookies.polka_session
      ? ((
          await db.query("SELECT account_id FROM sessions WHERE hash=$1 AND expires_at>now()", [
            sha256(req.cookies.polka_session),
          ])
        ).rows[0]?.account_id as string | undefined)
      : undefined;
    // Read locks: resolve only issues a grant, so concurrent views of one
    // shelf do not queue behind each other, while trash, revoke, disable and
    // deletion (which hold these rows FOR UPDATE) still serialize with it and
    // are rechecked once they commit.
    return transaction(async (c) => {
      const tokenHash = sha256(token);
      // Blocked by the operator or the content filter: «Ссылка недоступна»,
      // whatever else became of the link or its author. Nothing else is said.
      const blocked = (await c.query("SELECT 1 FROM shares WHERE token_hash=$1 AND moderation='blocked'", [tokenHash]))
        .rowCount;
      if (blocked) return { blocked: true as const };
      const candidate = (
        await c.query(
          `SELECT share.id,share.tenant_id,share.artifact_id,
                  account.id AS account_id,
                  (account.created_at IS NOT NULL
                    AND account.created_at>now()-$2*interval '1 day') AS author_is_new
           FROM shares share
           JOIN tenants tenant ON tenant.id=share.tenant_id
           JOIN accounts account ON account.id=${answeringAccountSql("tenant", "share")}
           AND ${linkShelfOpenSql("tenant")}
           WHERE share.token_hash=$1 AND NOT account.disabled
             AND account.deletion_requested_at IS NULL`,
          [tokenHash, config.NEW_ACCOUNT_DAYS],
        )
      ).rows[0];
      if (!candidate) throw missing();
      // The shelf and the account that answers for the link (owner or issuer).
      if (!(await lockAnsweringAccount(c, { id: candidate.account_id, tenant: candidate.tenant_id }, "SHARE")))
        throw missing();
      // An extension's policy (docs/specs/EXTENSIONS.md), e.g. employees only.
      if (extensions().length)
        await checkLinkOpen(
          {
            shareId: candidate.id,
            shelf: (await c.query("SELECT id,kind,name FROM tenants WHERE id=$1", [candidate.tenant_id])).rows[0],
            artifactId: candidate.artifact_id,
            viewer: viewerAccount ? { id: viewerAccount } : null,
          },
          c,
        );
      const artifact = (
        await c.query("SELECT title FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL FOR SHARE", [
          candidate.artifact_id,
          candidate.tenant_id,
        ])
      ).rows[0];
      if (!artifact) throw missing();
      const s = (
        await c.query(
          `SELECT * FROM shares
           WHERE id=$1 AND token_hash=$2 AND artifact_id=$3
             AND tenant_id=$4 AND NOT revoked AND expires_at>now()
           FOR SHARE`,
          [candidate.id, tokenHash, candidate.artifact_id, candidate.tenant_id],
        )
      ).rows[0];
      if (!s) throw missing();
      await assertEditorialShareAccessible(c, s.id);
      // Held for review or paused after reports: the recipient learns only
      // that, never the title or the content, and gets no grant.
      if (s.moderation !== "none") {
        // Held as spam: to everyone but its owner the link looks missing.
        if (String(s.moderation_reason ?? "").startsWith("spam:")) throw missing();
        return { review: true as const };
      }
      const editorial = !!(await c.query("SELECT 1 FROM editorial_publications WHERE share_id=$1", [s.id])).rowCount;
      const view = await issueShareGrant(c, s, candidate.artifact_id);
      if (!editorial && viewerAccount !== candidate.account_id) {
        trackShareOpened(c, candidate.account_id, s.id);
        // The author's own count of opens (docs/specs/LINK_OPENS.md): a number per day.
        await c.query(
          `INSERT INTO share_open_days(share_id,day,opens,last_opened_at)
           VALUES($1,(clock_timestamp() AT TIME ZONE 'UTC')::date,1,clock_timestamp())
           ON CONFLICT (share_id,day) DO UPDATE
             SET opens=share_open_days.opens+1,last_opened_at=clock_timestamp()`,
          [s.id],
        );
      }
      return {
        title: artifact.title ?? "Работа",
        ...view,
        publisher: editorial ? ("editorial" as const) : ("user" as const),
        authorIsNew: !editorial && candidate.author_is_new === true,
      };
    });
  });
  const granted = async (grant: string) => {
    const revision = (
      await db.query(
        `SELECT r.*,
           s.id AS authorized_share_id,
           g.derivative_id AS granted_derivative_id,
           CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
             'state',d.state,'runtimeProfile',d.runtime_profile,'reason',NULL,'path',NULL
           ) END AS inline_build
         FROM grants g
         JOIN shares s ON s.id=g.share_id
         JOIN revisions r ON r.id=g.revision_id
         JOIN artifacts a ON a.id=r.artifact_id AND a.id=s.artifact_id
         JOIN tenants tenant ON tenant.id=s.tenant_id
         JOIN accounts account ON account.id=${answeringAccountSql("tenant", "s")}
           AND ${linkShelfOpenSql("tenant")}
         LEFT JOIN revision_derivatives d ON d.id=g.derivative_id AND d.revision_id=g.revision_id
         WHERE g.hash=$1 AND g.expires_at>now() AND NOT s.revoked AND s.expires_at>now()
           AND a.trashed_at IS NULL
           AND NOT account.disabled AND account.deletion_requested_at IS NULL
           AND (
             ((r.storage_kind='single' OR ${staticSingleFileBundleSql("r")})
               AND g.derivative_id IS NULL)
             OR
             ($2::boolean AND r.storage_kind IN ('single','bundle') AND d.state='ready'
               AND d.source_manifest_sha256=r.manifest_sha256
               AND d.builder_version IN ${SERVED_BUILDER_VERSIONS_SQL}
               AND d.runtime_profile IN ${SERVED_RUNTIME_PROFILES_SQL})
           )`,
        [sha256(grant), config.HTML_LIVE_ENABLED],
      )
    ).rows[0];
    if (revision) await assertEditorialShareAccessible(db, revision.authorized_share_id);
    return revision;
  };
  app.get("/api/view/bytes", async (req, reply) => {
    const r = await granted(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
    if (!r) throw missing();
    // A link bound to an interactive version, and a page the static view
    // refuses, never hand the recipient the raw upload (as sendHtml).
    if (r.storage_kind === "bundle" || r.granted_derivative_id || r.html_profile === "unsupported") throw missing();
    reply.type(r.mime).header("content-security-policy", "sandbox; default-src 'none'");
    return readBlob(r.object_key, r.object_version);
  });
  app.post("/api/view/live-view", async (req) =>
    issueRecipientLiveView(req.headers.authorization?.replace(/^Bearer /, "") ?? "", withComments(req)),
  );
  // An iframe cannot send Authorization, so the short-lived (60 s), revision-bound
  // grant travels in the path. It is not the share token and dies with revoke.
  app.get("/api/view/:grant/document", async (req, reply) => {
    const { grant } = z.object({ grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(req.params);
    return sendHtml(req, reply, await granted(grant));
  });
}
