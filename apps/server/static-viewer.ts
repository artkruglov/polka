import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Actor } from "./artifacts.ts";
import { withSignedAwayLinks } from "./away-links.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { assertEditorialShareAccessible } from "./editorial.ts";
import { missing } from "./errors.ts";
import { staticHtmlCsp, withNewTabLinks } from "./html.ts";
import { overlayNonce, withStaticOverlay } from "./comment-overlay.ts";
import { staticSingleFileBundleSql } from "./revision-manifest.ts";
import { readBlob, sha256 } from "./storage.ts";

// The static (scriptless) view on the viewer domain. When a viewer is
// configured the app origin serves no saved HTML at all: the owner's and the
// recipient's static frames load from here, as the interactive ones do.
//
// Grants reuse viewer_grants with derivative_id NULL: owner grants are bound
// to the session, recipient grants to the /api/resolve grant. A static grant
// is stored under a hash in its own domain (STATIC_HASH), so it never opens
// /document (which runs scripts) and a live grant never opens /static.

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const staticHash = (token: string) => sha256(`static-view:${token}`);

/** The revision `r` has a static view: the same rule as the app's sendHtml. */
const STATIC_REVISION_SQL = `r.mime='text/html'
  AND COALESCE(r.html_profile,'')<>'unsupported'
  AND (r.storage_kind='single' OR ${staticSingleFileBundleSql("r")})`;

const staticViewResult = (token: string, expiresAt: Date) => ({
  url: `${config.VIEWER_ORIGIN}/static/${token}`,
  expiresAt: expiresAt.toISOString(),
});

export async function issueOwnerStaticView(
  actor: Actor,
  sessionToken: string,
  revisionId: string,
  comments = false,
) {
  if (!config.HTML_LIVE_ENABLED) throw missing();
  const token = randomBytes(32).toString("base64url");
  const sessionHash = sha256(sessionToken);
  const grant = await transaction(async (c) => {
    // Read locks: shelf covers issue these in parallel, while trash, disable
    // and deletion (FOR UPDATE) still serialize with them.
    await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR SHARE", [
      actor.tenant,
    ]);
    return (
      await c.query(
        `INSERT INTO viewer_grants(hash,revision_id,owner_session_hash,derivative_id,expires_at,comments)
         SELECT $1,r.id,session.hash,NULL,LEAST(now()+interval '60 seconds',session.expires_at),$6
         FROM revisions r
         JOIN artifacts artifact ON artifact.id=r.artifact_id
           AND artifact.tenant_id=r.tenant_id AND artifact.trashed_at IS NULL
         JOIN tenants tenant ON tenant.id=r.tenant_id
         JOIN sessions session ON session.hash=$2 AND session.account_id=$3
         JOIN accounts account ON account.id=session.account_id
           AND tenant.state='active'
         JOIN tenant_members member ON member.tenant_id=tenant.id
           AND member.account_id=account.id AND member.state='active'
         WHERE r.id=$4 AND r.tenant_id=$5 AND ${STATIC_REVISION_SQL}
           AND session.expires_at>now() AND NOT account.disabled
           AND account.deletion_requested_at IS NULL
         RETURNING expires_at`,
        [
          staticHash(token),
          sessionHash,
          actor.id,
          revisionId,
          actor.tenant,
          comments,
        ],
      )
    ).rows[0];
  });
  if (!grant) throw missing();
  return staticViewResult(token, grant.expires_at);
}

export async function issueRecipientStaticView(
  sourceGrant: string,
  comments = false,
) {
  if (!config.HTML_LIVE_ENABLED || !TOKEN.test(sourceGrant)) throw missing();
  const token = randomBytes(32).toString("base64url");
  const sourceGrantHash = sha256(sourceGrant);
  const grant = await transaction(async (c) => {
    const candidate = (
      await c.query(
        `SELECT s.id AS share_id,s.tenant_id,s.artifact_id
         FROM grants g JOIN shares s ON s.id=g.share_id WHERE g.hash=$1`,
        [sourceGrantHash],
      )
    ).rows[0];
    if (!candidate) throw missing();
    // As in issueRecipientLiveView: read locks, rechecked below.
    await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR SHARE", [
      candidate.tenant_id,
    ]);
    await c.query(
      "SELECT 1 FROM artifacts WHERE id=$1 AND tenant_id=$2 FOR SHARE",
      [candidate.artifact_id, candidate.tenant_id],
    );
    await c.query(
      "SELECT 1 FROM shares WHERE id=$1 AND tenant_id=$2 FOR SHARE",
      [candidate.share_id, candidate.tenant_id],
    );
    await assertEditorialShareAccessible(c, candidate.share_id);
    return (
      await c.query(
        `INSERT INTO viewer_grants(hash,revision_id,share_id,source_grant_hash,derivative_id,expires_at,comments)
         SELECT $1,r.id,s.id,g.hash,NULL,LEAST(now()+interval '60 seconds',g.expires_at),$3
         FROM grants g
         JOIN shares s ON s.id=g.share_id
         JOIN revisions r ON r.id=g.revision_id
         JOIN artifacts artifact ON artifact.id=r.artifact_id
           AND artifact.id=s.artifact_id AND artifact.trashed_at IS NULL
         JOIN tenants tenant ON tenant.id=s.tenant_id
         JOIN accounts account ON account.id=tenant.owner_id
         WHERE g.hash=$2 AND g.expires_at>now() AND g.derivative_id IS NULL
           AND NOT s.revoked AND s.expires_at>now()
           AND NOT account.disabled AND account.deletion_requested_at IS NULL
           AND ${STATIC_REVISION_SQL}
         RETURNING expires_at`,
        [staticHash(token), sourceGrantHash, comments],
      )
    ).rows[0];
  });
  if (!grant) throw missing();
  return staticViewResult(token, grant.expires_at);
}

/** Every condition is checked again on read: trash, revoke, logout, disable. */
async function authorizedStaticRevision(token: string) {
  if (!config.HTML_LIVE_ENABLED || !TOKEN.test(token)) return null;
  const {
    rows: [revision],
  } = await db.query(
    `SELECT r.*, vg.share_id AS authorized_share_id, vg.comments AS comment_overlay
     FROM viewer_grants vg
     JOIN revisions r ON r.id=vg.revision_id
     JOIN artifacts artifact ON artifact.id=r.artifact_id AND artifact.trashed_at IS NULL
     WHERE vg.hash=$1 AND vg.expires_at>now() AND vg.derivative_id IS NULL
       AND ${STATIC_REVISION_SQL}
       AND (
         (
           vg.owner_session_hash IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM sessions session
             JOIN accounts account ON account.id=session.account_id
             JOIN tenant_members member ON member.account_id=account.id
               AND member.state='active'
             JOIN tenants tenant ON tenant.id=member.tenant_id
               AND tenant.state='active'
             WHERE session.hash=vg.owner_session_hash
               AND session.expires_at>now() AND NOT account.disabled
               AND account.deletion_requested_at IS NULL
               AND tenant.id=r.tenant_id
           )
         )
         OR
         (
           vg.share_id IS NOT NULL AND vg.source_grant_hash IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM grants g
             JOIN shares s ON s.id=g.share_id
             JOIN tenants tenant ON tenant.id=s.tenant_id
             JOIN accounts account ON account.id=tenant.owner_id
             WHERE g.hash=vg.source_grant_hash
               AND g.share_id=vg.share_id AND g.revision_id=vg.revision_id
               AND g.derivative_id IS NULL AND s.artifact_id=r.artifact_id
               AND g.expires_at>now()
               AND NOT s.revoked AND s.expires_at>now()
               AND NOT account.disabled AND account.deletion_requested_at IS NULL
           )
         )
       )`,
    [staticHash(token)],
  );
  if (revision?.authorized_share_id)
    await assertEditorialShareAccessible(db, revision.authorized_share_id);
  return revision ?? null;
}

export function registerStaticViewerRoutes(viewer: FastifyInstance) {
  viewer.get("/static/:token", async (req, reply) => {
    // Embedding only, as /document: a top-level load of a user's page at a
    // Полка-run address could pose as Полка. Fetch Metadata is not
    // authentication; the grant is.
    if (
      req.headers["sec-fetch-dest"] !== "iframe" ||
      req.headers["sec-fetch-mode"] !== "navigate"
    )
      throw missing();
    const token = (req.params as { token?: string }).token ?? "";
    const revision = await authorizedStaticRevision(token);
    if (!revision) throw missing();
    const page = withNewTabLinks(
      withSignedAwayLinks(
        await readBlob(revision.object_key, revision.object_version),
        `${config.VIEWER_ORIGIN}/static/${token}`,
      ),
    );
    // With comments (asked for when the grant was issued), the one script
    // this response may run is the overlay, under a nonce of this response.
    const nonce = revision.comment_overlay ? overlayNonce() : undefined;
    reply
      .type("text/html; charset=utf-8")
      // Replaces the interactive CSP set for every viewer response: no
      // scripts of the page, and only the app may frame it.
      .header(
        "content-security-policy",
        staticHtmlCsp(config.APP_ORIGIN, nonce),
      );
    return nonce ? withStaticOverlay(page, config.APP_ORIGIN, nonce) : page;
  });
}
