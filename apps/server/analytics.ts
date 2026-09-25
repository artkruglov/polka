// First-party product analytics (deploy/migrations/034_product_analytics.sql,
// docs/legal/privacy.md «Статистика использования»).
//
// Events are written by this server into its own database: no cookies, no
// third-party scripts, no IP addresses, user agents or full URLs. An account
// is stored only as actorKey(id), an HMAC under a key derived from LINK_KEY.
// A recipient who opens a link is never identified: the event counts the
// link (at most once a day), on behalf of its owner.
//
// Writing an event never fails or delays the action it describes: inside a
// transaction it is written after the commit (never for a rolled-back
// action), and every error is swallowed with one log line.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { actorKey, shareKey } from "./analytics-keys.ts";
import { config } from "./config.ts";
import { afterCommit, db } from "./db.ts";

export { actorKey } from "./analytics-keys.ts";

export const ANALYTICS_EVENTS = [
  "page_view",
  "signup_completed",
  "agent_connected",
  "work_saved",
  "share_created",
  "share_opened",
  "note_added",
  "enterprise_request",
  "recipient_cta_view",
  "recipient_cta_click",
  "shelf_claimed",
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

/** Where a guest of a shared work saw the «сделано на Полке» prompt. */
export const RECIPIENT_CTA_SURFACES = ["bar", "card"] as const;
/** What they pressed in it. */
export const RECIPIENT_CTA_ACTIONS = [
  "try",
  "remix",
  "copy_phrase",
  "yandex",
  "email",
] as const;
/** Which page showed it: a shared work (/s) or a feed material (/discover). */
export const RECIPIENT_CTA_PAGES = ["share", "feed"] as const;
export type RecipientCtaEvent = { page?: (typeof RECIPIENT_CTA_PAGES)[number] } & (
  | { event: "view"; surface: (typeof RECIPIENT_CTA_SURFACES)[number] }
  | { event: "click"; action: (typeof RECIPIENT_CTA_ACTIONS)[number] }
);

/** Landing pages whose loads are counted (anonymous visitors only). */
export const PUBLIC_PAGES = new Set([
  "/",
  "/connect",
  "/enterprise",
  "/pricing",
  "/discover",
  "/signup",
]);

export type SignupMethod =
  | "email"
  | "yandex"
  | "vk"
  | "google"
  | "oidc"
  | "password"
  | "provisional";
export type AgentClient =
  | "codex"
  | "claude-code"
  | "claude-ai"
  | "chatgpt"
  | "browser-extension"
  | "token-http"
  | "token-mcp"
  | "other";
export type Via = "agent" | "api" | "web";
export type VisitSource = { ref?: string; referrer?: string };

type Props = Record<string, string | boolean>;
type Row = {
  name: AnalyticsEventName;
  actor: string | null;
  subject: string | null;
  props: Props;
  /** Add props.first: no earlier event of this name for this actor. */
  firstRecorded?: boolean;
  // analytics_daily dimensions
  path: string;
  source: string;
  detail: string;
};
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> };

// ---------------------------------------------------------------------------
// Which surface a request came through: the web app, MCP or the HTTP API.

export type Channel = "web" | "mcp" | "api";
const channel = new AsyncLocalStorage<Channel>();

/** Runs `fn` with `value` as the current channel (a Fastify preHandler). */
export function runInChannel<T>(value: Channel, fn: () => T): T {
  return channel.run(value, fn);
}

/**
 * How a save or a link was made: the HTTP publish API, an agent (MCP, or a
 * job an agent started) or the web app.
 */
export function viaFor(actor?: { connectionId?: string } | null): Via {
  const current = channel.getStore();
  if (current === "api") return "api";
  if (current === "mcp" || actor?.connectionId) return "agent";
  return "web";
}

// ---------------------------------------------------------------------------
// Sources and visitors.

const REF = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62}\.)*[a-z0-9-]{1,63}$/;

/** `ref` from a link: lower case, [a-z0-9._-], at most 40 characters. */
export function sanitizeRef(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const ref = value.trim().toLowerCase();
  return REF.test(ref) ? ref : null;
}

const ownHosts = () =>
  new Set(
    [config.APP_ORIGIN, config.VIEWER_ORIGIN]
      .filter(Boolean)
      .map((origin) => new URL(origin!).hostname.replace(/^www\./, "")),
  );

/** The host of an external referrer, never the path or query; else null. */
export function referrerHost(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  let host: string;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    host = url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
  } catch {
    return null;
  }
  if (host.length > 100 || !HOST.test(host) || ownHosts().has(host))
    return null;
  return host;
}

/** A source the browser reported (sign-up), sanitised like a page view's. */
export function sanitizeSource(value: unknown): VisitSource | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const ref = sanitizeRef(raw.ref);
  const referrer = referrerHost(raw.referrer);
  return ref || referrer
    ? { ...(ref ? { ref } : {}), ...(referrer ? { referrer } : {}) }
    : null;
}

/** The report's source label: the ref, else the referrer host, else "". */
export const sourceLabel = (source: VisitSource | null | undefined) =>
  source?.ref ? `ref:${source.ref}` : (source?.referrer ?? "");

const BOT =
  /bot|crawl|spider|slurp|scrap|fetch|preview|monitor|uptime|check|probe|scan|curl|wget|python|httpie|axios|undici|go-http|java\/|okhttp|libwww|headless|phantom|lighthouse|pagespeed|facebookexternalhit|vkshare|whatsapp|telegram|discord|slack|embedly|skype|claude|anthropic|openai|gpt|perplexity|bytespider/i;

/** A browser a person uses; bots, previews, scripts and fetchers are not. */
export function isHumanAgent(userAgent: unknown): boolean {
  return (
    typeof userAgent === "string" &&
    userAgent.length <= 1024 &&
    /^Mozilla\/5\.0 \(/.test(userAgent) &&
    !BOT.test(userAgent)
  );
}

// ---------------------------------------------------------------------------
// Writing.

const pending = new Set<Promise<void>>();

const INSERT = `WITH event AS (
    INSERT INTO analytics_events(id,name,actor,subject,props)
    SELECT $1,$2,$3,$4,$5::jsonb || CASE WHEN $9::boolean
        THEN jsonb_build_object('first', NOT EXISTS(
          SELECT 1 FROM analytics_events WHERE actor=$3 AND name=$2))
        ELSE '{}'::jsonb END
     WHERE $3::text IS NULL
        OR NOT EXISTS(SELECT 1 FROM analytics_optouts WHERE actor=$3)
    ON CONFLICT DO NOTHING
    RETURNING day
  )
  INSERT INTO analytics_daily(day,name,path,source,detail,count)
  SELECT day,$2,$6,$7,$8,1 FROM event
  ON CONFLICT(day,name,path,source,detail)
  DO UPDATE SET count=analytics_daily.count+1`;

function write(row: Row, q: Queryable = db) {
  const work = q
    .query(INSERT, [
      randomUUID(),
      row.name,
      row.actor,
      row.subject,
      JSON.stringify(row.props),
      row.path,
      row.source.slice(0, 120),
      row.detail,
      !!row.firstRecorded,
    ])
    .then(
      () => undefined,
      () => {
        console.error(
          JSON.stringify({ event: "analytics.write_failed", name: row.name }),
        );
      },
    );
  pending.add(work);
  void work.finally(() => pending.delete(work));
  return work;
}

/**
 * Written once the transaction of `c` commits; never if it rolls back. The
 * write starts before transaction() returns to its caller (db.ts), so
 * flushAnalytics() after an action sees it.
 */
function later(c: PoolClient, row: Row) {
  afterCommit(c, () => write(row));
}

/** Resolves when every event written so far is stored (tests, the CLI). */
export async function flushAnalytics() {
  for (let round = 0; round < 20; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!pending.size) return;
    await Promise.all([...pending]);
  }
}

const event = (
  name: AnalyticsEventName,
  fields: Partial<Omit<Row, "name">> = {},
): Row => ({
  name,
  actor: null,
  subject: null,
  props: {},
  path: "",
  source: "",
  detail: "",
  ...fields,
});

// ---------------------------------------------------------------------------
// Events.

type PageRequest = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query?: unknown;
  cookies?: Record<string, string | undefined>;
};

/**
 * A landing page was loaded by an anonymous person. Signed-in people, bots,
 * link previews, prefetches and HEAD requests are not counted. Kept: the
 * path, the sanitised `ref` and the referrer host only.
 */
export function trackPageView(req: PageRequest, path: string) {
  if (!PUBLIC_PAGES.has(path) || req.method !== "GET") return;
  if (req.cookies?.polka_session) return;
  const header = (name: string) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  if (
    /prefetch|prerender/i.test(
      `${header("sec-purpose") ?? ""} ${header("purpose") ?? ""}`,
    )
  )
    return;
  if (!isHumanAgent(header("user-agent"))) return;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const ref = sanitizeRef(query.ref);
  const referrer = referrerHost(header("referer"));
  const source = {
    ...(ref ? { ref } : {}),
    ...(referrer ? { referrer } : {}),
  };
  void write(
    event("page_view", {
      props: { path, ...source },
      path,
      source: sourceLabel(source),
    }),
  );
}

/** A new account (email code, Яндекс ID, VK ID, OIDC or operator password). */
export function trackSignup(
  c: PoolClient,
  accountId: string,
  method: SignupMethod,
  source?: VisitSource | null,
) {
  const clean = sanitizeSource(source ?? null);
  later(
    c,
    event("signup_completed", {
      actor: actorKey(accountId),
      props: { method, ...(clean ?? {}) },
      source: sourceLabel(clean),
      detail: method,
    }),
  );
  afterCommit(c, () => markActive(accountId));
}

/**
 * A provisional shelf got a sign-in method (migration 036): `method` is
 * email, yandex, vk, google, oidc or merge (moved into an existing shelf).
 */
export function trackShelfClaimed(
  c: PoolClient,
  accountId: string,
  method: "email" | "yandex" | "vk" | "google" | "oidc" | "merge",
) {
  later(
    c,
    event("shelf_claimed", {
      actor: actorKey(accountId),
      props: { method },
      detail: method,
    }),
  );
}

/** Which agent an OAuth client is, from its name and where it returns to. */
export function oauthClientKind(
  name: string | null | undefined,
  redirectUris: readonly string[],
): AgentClient {
  const hosts = redirectUris.flatMap((uri) => {
    try {
      return [new URL(uri).hostname.toLowerCase()];
    } catch {
      return [];
    }
  });
  const on = (...known: string[]) =>
    hosts.some((host) =>
      known.some((item) => host === item || host.endsWith(`.${item}`)),
    );
  if (on("claude.ai", "claude.com", "anthropic.com")) return "claude-ai";
  if (on("chatgpt.com", "openai.com")) return "chatgpt";
  if (on("chromiumapp.org")) return "browser-extension";
  const label = String(name ?? "").toLowerCase();
  if (/codex/.test(label)) return "codex";
  if (/claude[\s_-]*code/.test(label)) return "claude-code";
  return "other";
}

/** A connection's first success: an OAuth grant, or a token's first call. */
export function trackAgentConnected(
  q: PoolClient | null,
  accountId: string,
  client: AgentClient,
  first: boolean,
) {
  const row = event("agent_connected", {
    actor: actorKey(accountId),
    props: { client, first },
    detail: client,
  });
  if (q) later(q, row);
  else void write(row);
}

export function trackWorkSaved(
  c: PoolClient,
  accountId: string,
  via: Via,
  first: boolean,
  kind: "new" | "revision",
) {
  later(
    c,
    event("work_saved", {
      actor: actorKey(accountId),
      props: { via, first, kind },
      detail: via,
    }),
  );
}

/** A link was made; `first` is the account's first recorded one. */
export function trackShareCreated(c: PoolClient, accountId: string, via: Via) {
  later(
    c,
    event("share_created", {
      actor: actorKey(accountId),
      props: { via },
      firstRecorded: true,
      detail: via,
    }),
  );
}

/** A recipient opened the link: counted for its owner, once a day per link. */
export function trackShareOpened(
  c: PoolClient,
  ownerAccountId: string,
  shareId: string,
) {
  later(
    c,
    event("share_opened", {
      actor: actorKey(ownerAccountId),
      subject: shareKey(shareId),
    }),
  );
}

export function trackNoteAdded(
  c: PoolClient,
  accountId: string,
  by: "owner" | "reader",
  via: Via,
) {
  later(
    c,
    event("note_added", {
      actor: actorKey(accountId),
      props: { by, via },
      detail: by,
    }),
  );
}

/**
 * A guest of a shared work or a feed material saw the prompt (the bar once
 * per load, the card each time it opens) or pressed something in it.
 * Anonymous like a page view: the path is /s for every link and /discover
 * for every material; the link or the material itself is never named.
 */
export function trackRecipientCta(input: RecipientCtaEvent) {
  const detail = input.event === "view" ? input.surface : input.action;
  const path = input.page === "feed" ? "/discover" : "/s";
  void write(
    event(
      input.event === "view" ? "recipient_cta_view" : "recipient_cta_click",
      {
        props: {
          ...(input.event === "view"
            ? { surface: input.surface }
            : { action: input.action }),
          path,
        },
        path,
        detail,
      },
    ),
  );
}

export function trackEnterpriseRequest(interest: string, teamSize: string) {
  void write(
    event("enterprise_request", {
      props: { interest, teamSize },
      detail: interest,
    }),
  );
}

// ---------------------------------------------------------------------------
// Returning activity: one row per account and day.

let today = "";
const seen = new Set<string>();

/** Any authenticated action; written at most once per account and day. */
export function markActive(accountId: string) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== today || seen.size > 100_000) {
    today = day;
    seen.clear();
  }
  const actor = actorKey(accountId);
  if (seen.has(actor)) return;
  seen.add(actor);
  const work = db
    .query(
      `INSERT INTO analytics_active_days(actor,day)
       SELECT $1,$2::date
        WHERE NOT EXISTS(SELECT 1 FROM analytics_optouts WHERE actor=$1)
       ON CONFLICT DO NOTHING`,
      [actor, day],
    )
    .then(
      () => undefined,
      () => {
        seen.delete(actor);
        console.error(JSON.stringify({ event: "analytics.active_failed" }));
      },
    );
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

// ---------------------------------------------------------------------------
// Erasure.

/**
 * Deletes an account's events and active days. With `optOut` (an objection
 * under the privacy policy) its new events are not written either.
 */
export async function forgetAccount(
  q: Queryable,
  accountId: string,
  optOut = false,
) {
  const actor = actorKey(accountId);
  if (optOut)
    await q.query(
      "INSERT INTO analytics_optouts(actor) VALUES($1) ON CONFLICT DO NOTHING",
      [actor],
    );
  const events = await q.query("DELETE FROM analytics_events WHERE actor=$1", [
    actor,
  ]);
  const days = await q.query(
    "DELETE FROM analytics_active_days WHERE actor=$1",
    [actor],
  );
  seen.delete(actor);
  return { events: events.rowCount ?? 0, activeDays: days.rowCount ?? 0 };
}

/** forgetAccount once the transaction of `c` (a deletion request) commits. */
export function forgetAccountLater(c: PoolClient, accountId: string) {
  afterCommit(c, () => {
    const work = forgetAccount(db, accountId).then(
      () => undefined,
      () => {
        console.error(JSON.stringify({ event: "analytics.forget_failed" }));
      },
    );
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return work;
  });
}
