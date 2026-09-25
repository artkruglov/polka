import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import type { PoolClient } from "pg";
import type { Actor } from "./artifacts.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { readBlob, sha256 } from "./storage.ts";
import { liveViewerCsp, withViewerGuard } from "./html.ts";
import {
  SERVED_BUILDER_VERSIONS_SQL,
  SERVED_RUNTIME_PROFILES_SQL,
  derivativePreferenceSql,
} from "./bundle-runtime-contract.ts";
import { assertEditorialShareAccessible } from "./editorial.ts";
import { isLiveRevisionEligible } from "./viewer-config.ts";
import { readLibraryLiveDocument } from "./template-library-viewer.ts";
import { registerStaticViewerRoutes } from "./static-viewer.ts";
import { registerProjectViewerRoutes } from "./project-viewer.ts";
import { withLiveOverlay } from "./comment-overlay.ts";

export const LIVE_HTML_PROFILE = "inline-live-experimental-v1" as const;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const liveViewResult = (token: string, expiresAt: Date, profile: string) => ({
  url: `${config.VIEWER_ORIGIN}/document/${token}`,
  expiresAt: expiresAt.toISOString(),
  profile,
});

/** The runtime profile of the derivative a new viewer grant is bound to. */
async function grantedProfile(c: PoolClient, derivativeId: string | null) {
  if (!derivativeId) return LIVE_HTML_PROFILE;
  const {
    rows: [row],
  } = await c.query(
    "SELECT runtime_profile FROM revision_derivatives WHERE id=$1",
    [derivativeId],
  );
  return row.runtime_profile as string;
}

export async function issueOwnerLiveView(
  actor: Actor,
  sessionToken: string,
  revisionId: string,
  comments = false,
) {
  if (!isLiveRevisionEligible(config, revisionId)) throw missing();
  const token = randomBytes(32).toString("base64url");
  const sessionHash = sha256(sessionToken);
  const grant = await transaction(async (c) => {
    const owner = await c.query(
      `SELECT 1 FROM tenants tenant
       JOIN tenant_members member ON member.tenant_id=tenant.id
         AND member.state='active'
       JOIN accounts account ON account.id=member.account_id
       JOIN sessions session ON session.account_id=account.id
       WHERE tenant.id=$1 AND tenant.state='active' AND account.id=$2
         AND session.hash=$3
         AND session.expires_at>now() AND NOT account.disabled
         AND account.deletion_requested_at IS NULL
       FOR UPDATE OF tenant`,
      [actor.tenant, actor.id, sessionHash],
    );
    if (!owner.rowCount) throw missing();
    const revision = (
      await c.query(
        "SELECT artifact_id FROM revisions WHERE id=$1 AND tenant_id=$2",
        [revisionId, actor.tenant],
      )
    ).rows[0];
    if (!revision) throw missing();
    const artifact = await c.query(
      "SELECT 1 FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL FOR UPDATE",
      [revision.artifact_id, actor.tenant],
    );
    if (!artifact.rowCount) throw missing();
    const inserted = (
      await c.query(
        `INSERT INTO viewer_grants(hash,revision_id,owner_session_hash,derivative_id,expires_at,comments)
         SELECT $1,r.id,$2,d.id,LEAST(now()+interval '60 seconds',session.expires_at),$6
         FROM revisions r
         JOIN sessions session ON session.hash=$2 AND session.account_id=$3
         JOIN accounts account ON account.id=session.account_id
         LEFT JOIN LATERAL (
           -- The owner runs what a link recipient would: the built version
           -- when one is ready (single uploads too), else the single upload.
           SELECT d.id FROM revision_derivatives d
           WHERE r.storage_kind IN ('single','bundle')
             AND d.revision_id=r.id AND d.source_manifest_sha256=r.manifest_sha256
             AND d.builder_version IN ${SERVED_BUILDER_VERSIONS_SQL}
             AND d.runtime_profile IN ${SERVED_RUNTIME_PROFILES_SQL} AND d.state='ready'
           ORDER BY ${derivativePreferenceSql("d")} LIMIT 1
         ) d ON true
         WHERE r.id=$4 AND r.tenant_id=$5 AND r.mime='text/html'
           AND (r.storage_kind='single' OR (r.storage_kind='bundle' AND d.id IS NOT NULL))
           AND session.expires_at>now() AND NOT account.disabled
           AND account.deletion_requested_at IS NULL
         RETURNING expires_at,derivative_id`,
        [sha256(token), sessionHash, actor.id, revisionId, actor.tenant, comments],
      )
    ).rows[0];
    return (
      inserted && {
        ...inserted,
        profile: await grantedProfile(c, inserted.derivative_id),
      }
    );
  });
  if (!grant) throw missing();
  return liveViewResult(token, grant.expires_at, grant.profile);
}

export async function issueRecipientLiveView(
  sourceGrant: string,
  comments = false,
) {
  if (!config.HTML_LIVE_ENABLED || !TOKEN.test(sourceGrant)) throw missing();
  const token = randomBytes(32).toString("base64url");
  const sourceGrantHash = sha256(sourceGrant);
  const grant = await transaction(async (c) => {
    const candidate = (
      await c.query(
        `SELECT s.id AS share_id,s.tenant_id,s.artifact_id,g.revision_id
         FROM grants g JOIN shares s ON s.id=g.share_id
         WHERE g.hash=$1`,
        [sourceGrantHash],
      )
    ).rows[0];
    if (!candidate) throw missing();
    if (!isLiveRevisionEligible(config, candidate.revision_id)) throw missing();
    // Read locks, as in /api/resolve: recipients of one owner's links must
    // not queue behind each other, while trash, revoke, disable and deletion
    // (FOR UPDATE) still serialize with this and are rechecked below.
    await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR SHARE", [
      candidate.tenant_id,
    ]);
    const artifact = await c.query(
      "SELECT 1 FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL FOR SHARE",
      [candidate.artifact_id, candidate.tenant_id],
    );
    if (!artifact.rowCount) throw missing();
    await c.query(
      "SELECT 1 FROM shares WHERE id=$1 AND tenant_id=$2 FOR SHARE",
      [candidate.share_id, candidate.tenant_id],
    );
    await assertEditorialShareAccessible(c, candidate.share_id);
    const inserted = (
      await c.query(
        `INSERT INTO viewer_grants(hash,revision_id,share_id,source_grant_hash,derivative_id,expires_at,comments)
         SELECT $1,r.id,s.id,g.hash,g.derivative_id,LEAST(now()+interval '60 seconds',g.expires_at),$3
         FROM grants g
         JOIN shares s ON s.id=g.share_id
         JOIN revisions r ON r.id=g.revision_id
         JOIN tenants tenant ON tenant.id=s.tenant_id
         JOIN accounts account ON account.id=tenant.owner_id
         LEFT JOIN revision_derivatives d ON d.id=g.derivative_id AND d.revision_id=g.revision_id
         WHERE g.hash=$2 AND g.expires_at>now()
           AND NOT s.revoked AND s.expires_at>now() AND r.mime='text/html'
           AND NOT account.disabled AND account.deletion_requested_at IS NULL
           AND (r.storage_kind IN ('single','bundle') AND d.state='ready'
               AND d.source_manifest_sha256=r.manifest_sha256
               AND d.builder_version IN ${SERVED_BUILDER_VERSIONS_SQL}
               AND d.runtime_profile IN ${SERVED_RUNTIME_PROFILES_SQL})
         RETURNING expires_at,derivative_id`,
        [sha256(token), sourceGrantHash, comments],
      )
    ).rows[0];
    return (
      inserted && {
        ...inserted,
        profile: await grantedProfile(c, inserted.derivative_id),
      }
    );
  });
  if (!grant) throw missing();
  return liveViewResult(token, grant.expires_at, grant.profile);
}

async function authorizedRevision(token: string) {
  if (!config.HTML_LIVE_ENABLED || !TOKEN.test(token)) return null;
  const {
    rows: [revision],
  } = await db.query(
    `SELECT r.*,
       vg.share_id AS authorized_share_id,vg.comments AS comment_overlay,
       COALESCE(d.object_key,r.object_key) AS served_object_key,
       COALESCE(d.object_version,r.object_version) AS served_object_version
     FROM viewer_grants vg
     JOIN revisions r ON r.id=vg.revision_id
     JOIN artifacts artifact ON artifact.id=r.artifact_id AND artifact.trashed_at IS NULL
     LEFT JOIN revision_derivatives d ON d.id=vg.derivative_id AND d.revision_id=vg.revision_id
     WHERE vg.hash=$1 AND vg.expires_at>now() AND r.mime='text/html'
       AND ((r.storage_kind='single' AND vg.derivative_id IS NULL
             AND vg.owner_session_hash IS NOT NULL)
         OR (r.storage_kind IN ('single','bundle') AND d.state='ready'
           AND d.source_manifest_sha256=r.manifest_sha256
           AND d.builder_version IN ${SERVED_BUILDER_VERSIONS_SQL}
           AND d.runtime_profile IN ${SERVED_RUNTIME_PROFILES_SQL}))
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
               AND g.derivative_id IS NOT DISTINCT FROM vg.derivative_id
               AND g.expires_at>now()
               AND NOT s.revoked AND s.expires_at>now()
               AND NOT account.disabled AND account.deletion_requested_at IS NULL
           )
         )
       )`,
    [sha256(token)],
  );
  if (revision && !isLiveRevisionEligible(config, revision.id)) return null;
  if (revision?.authorized_share_id)
    await assertEditorialShareAccessible(db, revision.authorized_share_id);
  return revision ?? null;
}

export async function createLiveViewerApp() {
  const viewer = Fastify({
    logger: false,
    requestTimeout: 30000,
    connectionTimeout: 30000,
  });
  viewer.addHook("onRequest", async (req, reply) => {
    reply.headers({
      "cache-control": "no-store",
      "content-security-policy": liveViewerCsp(config.APP_ORIGIN),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
      // DNS prefetch is outside CSP; a hostname can carry data out.
      "x-dns-prefetch-control": "off",
    });
    // The reverse proxy must replace Host with this fixed upstream authority.
    // Forwarded authority is deliberately ignored.
    if (req.headers.host !== config.VIEWER_UPSTREAM_HOST) throw missing();
  });
  viewer.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof Problem)
      return reply
        .code(error.status)
        .send({ code: error.code, message: error.message });
    // Capability paths and stored HTML are intentionally absent from logs.
    console.error(
      JSON.stringify({
        event: "viewer.request.failed",
        code: typeof error.code === "string" ? error.code : "internal",
      }),
    );
    return reply.code(500).send({
      code: "internal",
      message: "Не удалось открыть сохранённую версию.",
    });
  });
  viewer.get("/document/:token", async (req, reply) => {
    // Browser-only embedding keeps the parent frame-src policy in force.
    // Fetch Metadata is not authentication: non-browser clients can forge it.
    if (
      req.headers["sec-fetch-dest"] !== "iframe" ||
      req.headers["sec-fetch-mode"] !== "navigate"
    )
      throw missing();
    const token = (req.params as { token?: string }).token ?? "";
    const revision = await authorizedRevision(token);
    if (!revision) throw missing();
    reply.type("text/html; charset=utf-8");
    // The pinned blob plus the static WebRTC guard (html.ts); never inject
    // capabilities, sessions or API data. The comment overlay only when the
    // shell asked for it when the grant was issued.
    const bytes = await readBlob(
      revision.served_object_key,
      revision.served_object_version,
    );
    return revision.comment_overlay
      ? withLiveOverlay(bytes, config.APP_ORIGIN)
      : withViewerGuard(bytes);
  });
  viewer.get("/library-document/:token", async (req, reply) => {
    if (
      req.headers["sec-fetch-dest"] !== "iframe" ||
      req.headers["sec-fetch-mode"] !== "navigate"
    )
      throw missing();
    const token = (req.params as { token?: string }).token ?? "";
    const bytes = await readLibraryLiveDocument(token);
    reply.type("text/html; charset=utf-8");
    return withViewerGuard(bytes);
  });
  registerStaticViewerRoutes(viewer);
  registerProjectViewerRoutes(viewer);
  return viewer;
}
