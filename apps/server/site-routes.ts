import { extensions } from "./extensions.ts";
import { connectGuide } from "./connect-guide.ts";
import { robotsTxt, sitemapXml } from "./indexing.ts";
import { registerAgentDiscovery } from "./agent-discovery.ts";
import { authorizeOpsStatus, opsStatus } from "./ops-status.ts";
import { registerOpsMetrics } from "./metrics.ts";
import { trackPageView } from "./analytics.ts";
import { POLKA_VERSION } from "./mcp-server.ts";
import { importSources } from "./url-import/routes.ts";
import { z } from "zod";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { linkOnly, PROVIDER_NAMES } from "./sign-in-providers.ts";
import { LIVE_HTML_PROFILE } from "./live-viewer.ts";
import { MAX_BYTES, MIME } from "../../packages/contracts/index.ts";
import { getEditorial, listEditorial } from "./editorial.ts";
import { createStarCounter } from "./source-stars.ts";
import type { FastifyInstance } from "fastify";

/** The GitHub star count of SOURCE_URL for the header (source-stars.ts); one cache per process. */
export const sourceStars = createStarCounter({ sourceUrl: config.SOURCE_URL });

/** Public pages and machine-readable files, health, capabilities and the feed. */
export function registerSiteRoutes(app: FastifyInstance) {
  // Agent-readable setup: "Connect Полка: <origin>/connect".
  app.get("/robots.txt", async (_req, reply) =>
    reply
      .header("cache-control", "public, max-age=3600")
      .type("text/plain; charset=utf-8")
      .send(robotsTxt(config.APP_ORIGIN)),
  );
  app.get("/sitemap.xml", async (_req, reply) =>
    reply
      .header("cache-control", "public, max-age=3600")
      .type("application/xml; charset=utf-8")
      .send(
        sitemapXml(
          config.APP_ORIGIN,
          (await listEditorial()).items.map((item) => item.slug),
        ),
      ),
  );
  app.get("/connect", async (req, reply) => {
    trackPageView(req, "/connect");
    return reply.type("text/plain; charset=utf-8").send(connectGuide(config.APP_ORIGIN, config.SOURCE_URL));
  });
  // Cold discovery for agents: /llms.txt, /openapi.json, Agent Skills index.
  registerAgentDiscovery(app);
  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });
  // For the operator's monitor only: 404 unless OPS_STATUS_TOKEN is set and
  // presented. 503 when a check fails, so a plain HTTP probe can alert on it.
  app.get("/api/ops/status", async (req, reply) => {
    authorizeOpsStatus(req.headers.authorization);
    const status = await opsStatus(POLKA_VERSION);
    return reply.code(status.ok ? 200 : 503).send(status);
  });
  // Product metrics for the operator: the same token (metrics.ts).
  registerOpsMetrics(app);
  app.get("/api/capabilities", async () => ({
    // Extensions with a part in the web app (docs/specs/EXTENSIONS.md).
    extensions: extensions()
      .filter((extension) => extension.web?.script)
      .map((extension) => extension.name),
    profile: "file-v1",
    formats: MIME,
    maxBytes: MAX_BYTES,
    audiences: ["private", "unlisted"],
    // HTML is shown only as a static sandboxed page; ZIP bundles are not accepted yet.
    htmlRuntime: false,
    liveExperimental: config.HTML_LIVE_ENABLED,
    liveMode: config.HTML_LIVE_MODE,
    liveProfile: config.HTML_LIVE_ENABLED ? LIVE_HTML_PROFILE : null,
    // Mirrors /api/imports/capabilities: when disabled, links are only recognised in the browser.
    urlImport: config.URL_IMPORT_ENABLED,
    urlImportSources: config.URL_IMPORT_ENABLED ? importSources() : [],
    htmlView: "static-sandbox",
    identity: "operator-provisioned-local-account",
    emailLogin: config.MAIL_MODE,
    emailSignup: config.EMAIL_SIGNUP,
    // Where a new shelf may open by an emailed code: "any" or the domains.
    emailSignupDomains: config.EMAIL_SIGNUP_DOMAINS,
    // Existing accounts outside those domains still get codes ("any").
    emailLoginDomains: config.EMAIL_LOGIN_DOMAINS,
    signInProviders: config.SIGN_IN_PROVIDERS.map((id) => ({
      id,
      name: PROVIDER_NAMES[id](),
      // false: signs in only to a shelf it is linked to (GOOGLE_SIGNUP).
      signup: !linkOnly(id),
    })),
    commentsMode: config.COMMENTS_MODE,
    // Where an owner asks to delete the shelf and its data (settings,
    // «Удалить полку»); null: the page says «оператору этой установки».
    privacyContact: config.OPERATOR_CONTACT ?? config.OPERATOR_EMAIL ?? null,
    // «Удалить аккаунт» in the settings (ACCOUNT_DELETION_ENABLED); `purge`: a worker erases the data.
    accountDeletion: config.ACCOUNT_DELETION_ENABLED ? { purge: config.ACCOUNT_DELETION_PURGE_WORKER } : null,
    // AGPL-3.0 § 13: the interface links users to this installation's source.
    sourceUrl: config.SOURCE_URL,
  }));
  // The star count of SOURCE_URL on GitHub, fetched server-side (the browser
  // may not talk to GitHub) and cached for an hour. Not a GitHub repository,
  // or GitHub not answering: { stars: null }, never an error.
  app.get("/api/source/stars", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=600");
    return { stars: await sourceStars.stars() };
  });
  app.get("/api/editorial", listEditorial);
  app.get("/api/editorial/:slug", async (req) => {
    const { slug } = z
      .object({
        slug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(80),
      })
      .parse(req.params);
    return getEditorial(slug);
  });
}
