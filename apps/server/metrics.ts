// The operator's product report (deploy/hosted/README.md, «Метрики продукта»).
//
//   GET /api/ops/metrics?weeks=12   JSON, Bearer OPS_STATUS_TOKEN (as /api/ops/status)
//   GET /ops/metrics                a page that asks for the token and draws tables
//
// Everything is computed from analytics.ts rows: pseudonymous actor keys,
// anonymous counters. The report names no account, address or link.
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { missing } from "./errors.ts";
import { authorizeOpsStatus } from "./ops-status.ts";

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> };

export const FUNNEL_STEPS = [
  "visitors",
  "signups",
  "agentConnected",
  "firstSave",
  "firstShare",
  "shareOpened",
] as const;

/** Event of each step after sign-up (reached at any time, not only that week). */
const STEP_EVENTS = {
  agentConnected: "agent_connected",
  firstSave: "work_saved",
  firstShare: "share_created",
  shareOpened: "share_opened",
} as const;
type Step = keyof typeof STEP_EVENTS;

/** Retention windows, in days after the sign-up day (inclusive). */
export const RETENTION_WINDOWS = {
  d1: [1, 1],
  d7: [7, 13],
  d30: [30, 36],
} as const;

const DEFINITIONS = {
  week: "ISO week (Monday, UTC) of the sign-up or of the event.",
  visitors:
    "Loads of the landing pages (/, /connect, /enterprise, /pricing, /discover, /signup) by anonymous people; bots, previews, prefetches and signed-in people are not counted. A page view, not a unique visitor: there are no identifiers.",
  signups:
    "Accounts created that week (email code, Яндекс ID, VK ID, OIDC, operator password).",
  funnel:
    "Of the accounts created that week, how many reached each step by now, each step also requiring the previous ones (reached: without that requirement).",
  agentConnected:
    "An OAuth connection was granted, or a token connection made its first call.",
  firstSave: "A work was saved (web, agent or the HTTP API).",
  firstShare: "A link was made.",
  shareOpened:
    "A recipient opened one of their links (the owner's own views and editorial links excluded; a link counts once a day).",
  retention:
    "Of a sign-up week's accounts, the share active (any signed-in or agent action) on day 1, on days 7–13 and on days 30–36 after sign-up. Only accounts whose window is over are counted (eligible).",
  sources:
    "ref:<value> from a link's ?ref=, else the referrer host, else (direct). A sign-up carries the source of the tab it came from.",
  recipients:
    "Guests of shared works, by week of the event: links opened (a link once a day, editorial links excluded), loads that showed the bar «сделали с ИИ и сохранили на Полку» (every guest load, editorial pages too), openings of the card, presses by action, and sign-ups whose source is ref:share or ref:share-remix (the tab's source is set when the prompt is pressed). Anonymous counters; conversions are ratios of the counts, not of people.",
};

/** The prompt's presses, in the report's column order (analytics.ts). */
export const RECIPIENT_ACTIONS = [
  "try",
  "remix",
  "copy_phrase",
  "yandex",
  "email",
] as const;
type RecipientAction = (typeof RECIPIENT_ACTIONS)[number];

export type RecipientWeek = {
  week: string;
  opened: number;
  barViews: number;
  cardViews: number;
  clicks: Record<RecipientAction, number>;
  clicksTotal: number;
  signups: number;
  conversion: {
    barToCard: number | null;
    cardToClick: number | null;
    clickToSignup: number | null;
    barToSignup: number | null;
  };
};

const recipientConversion = (row: Omit<RecipientWeek, "conversion" | "week">) => ({
  barToCard: rate(row.cardViews, row.barViews),
  cardToClick: rate(row.clicksTotal, row.cardViews),
  clickToSignup: rate(row.signups, row.clicksTotal),
  barToSignup: rate(row.signups, row.barViews),
});

const emptyRecipientWeek = () => ({
  opened: 0,
  barViews: 0,
  cardViews: 0,
  clicks: Object.fromEntries(RECIPIENT_ACTIONS.map((a) => [a, 0])) as Record<
    RecipientAction,
    number
  >,
  clicksTotal: 0,
  signups: 0,
});

/**
 * «Получатели → регистрации»: the recipient page's prompt, from the daily
 * counters only (there is no actor on any of these events).
 */
export function recipientFunnel(
  weeks: string[],
  daily: Array<{ day: string; name: string; source: string; detail: string; count: number }>,
) {
  const byWeek = new Map(weeks.map((week) => [week, emptyRecipientWeek()]));
  for (const row of daily) {
    const entry = byWeek.get(weekOf(row.day));
    if (!entry) continue;
    if (row.name === "share_opened") entry.opened += row.count;
    else if (row.name === "recipient_cta_view") {
      if (row.detail === "bar") entry.barViews += row.count;
      else if (row.detail === "card") entry.cardViews += row.count;
    } else if (row.name === "recipient_cta_click") {
      if ((RECIPIENT_ACTIONS as readonly string[]).includes(row.detail)) {
        entry.clicks[row.detail as RecipientAction] += row.count;
        entry.clicksTotal += row.count;
      }
    } else if (
      row.name === "signup_completed" &&
      (row.source === "ref:share" || row.source === "ref:share-remix")
    )
      entry.signups += row.count;
  }
  const rows: RecipientWeek[] = weeks.map((week) => {
    const entry = byWeek.get(week)!;
    return { week, ...entry, conversion: recipientConversion(entry) };
  });
  const total = emptyRecipientWeek();
  for (const row of rows) {
    total.opened += row.opened;
    total.barViews += row.barViews;
    total.cardViews += row.cardViews;
    total.clicksTotal += row.clicksTotal;
    total.signups += row.signups;
    for (const action of RECIPIENT_ACTIONS) total.clicks[action] += row.clicks[action];
  }
  return {
    actions: RECIPIENT_ACTIONS,
    weeks: rows,
    total: { ...total, conversion: recipientConversion(total) },
  };
}

// ---------------------------------------------------------------------------
// Dates as YYYY-MM-DD strings (UTC).

const DAY = 86_400_000;
export const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
export function weekOf(day: string) {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

const rate = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 10_000) / 10_000 : null;

// ---------------------------------------------------------------------------
// Pure computations (tested on synthetic cohorts).

export type Signup = { actor: string; day: string; method?: string | null };

export function funnelWeeks(
  weeks: string[],
  signups: Signup[],
  reached: Map<string, Set<Step>>,
  visitorsByWeek: Map<string, number>,
) {
  const rows = weeks.map((week) => {
    const cohort = signups.filter((signup) => weekOf(signup.day) === week);
    const has = (actor: string, step: Step) =>
      reached.get(actor)?.has(step) ?? false;
    const nested = {
      agentConnected: 0,
      firstSave: 0,
      firstShare: 0,
      shareOpened: 0,
    };
    const any = { ...nested };
    for (const { actor } of cohort) {
      let chain = true;
      for (const step of Object.keys(STEP_EVENTS) as Step[]) {
        const did = has(actor, step);
        if (did) any[step]++;
        chain &&= did;
        if (chain) nested[step]++;
      }
    }
    const visitors = visitorsByWeek.get(week) ?? 0;
    const signupCount = cohort.length;
    return {
      week,
      visitors,
      signups: signupCount,
      ...nested,
      reached: any,
      conversion: {
        visitorToSignup: rate(signupCount, visitors),
        signupToAgent: rate(nested.agentConnected, signupCount),
        agentToSave: rate(nested.firstSave, nested.agentConnected),
        saveToShare: rate(nested.firstShare, nested.firstSave),
        shareToOpened: rate(nested.shareOpened, nested.firstShare),
        signupToOpened: rate(nested.shareOpened, signupCount),
      },
    };
  });
  const sum = (key: "visitors" | "signups" | Step) =>
    rows.reduce((total, row) => total + row[key], 0);
  const total = {
    visitors: sum("visitors"),
    signups: sum("signups"),
    agentConnected: sum("agentConnected"),
    firstSave: sum("firstSave"),
    firstShare: sum("firstShare"),
    shareOpened: sum("shareOpened"),
  };
  return {
    steps: FUNNEL_STEPS,
    weeks: rows,
    total: {
      ...total,
      conversion: {
        visitorToSignup: rate(total.signups, total.visitors),
        signupToAgent: rate(total.agentConnected, total.signups),
        agentToSave: rate(total.firstSave, total.agentConnected),
        saveToShare: rate(total.firstShare, total.firstSave),
        shareToOpened: rate(total.shareOpened, total.firstShare),
        signupToOpened: rate(total.shareOpened, total.signups),
      },
    },
  };
}

export function retentionCohorts(
  weeks: string[],
  signups: Signup[],
  activeDays: Map<string, Set<string>>,
  today: string,
) {
  return weeks.map((week) => {
    const cohort = signups.filter((signup) => weekOf(signup.day) === week);
    const windows = Object.fromEntries(
      Object.entries(RETENTION_WINDOWS).map(([name, [from, to]]) => {
        let eligible = 0;
        let retained = 0;
        for (const { actor, day } of cohort) {
          // A window counts once it is over (today is not over yet).
          if (addDays(day, to) >= today) continue;
          eligible++;
          const days = activeDays.get(actor);
          for (let offset = from; offset <= to; offset++)
            if (days?.has(addDays(day, offset))) {
              retained++;
              break;
            }
        }
        return [name, { eligible, retained, rate: rate(retained, eligible) }];
      }),
    ) as Record<
      keyof typeof RETENTION_WINDOWS,
      { eligible: number; retained: number; rate: number | null }
    >;
    return { week, cohort: cohort.length, ...windows };
  });
}

// ---------------------------------------------------------------------------
// The report.

type DailyRow = {
  day: string;
  name: string;
  path: string;
  source: string;
  detail: string;
  count: number;
};

export async function metricsReport(
  options: { weeks?: number; today?: string } = {},
  q: Queryable = db,
) {
  const count = Math.min(Math.max(Math.trunc(options.weeks ?? 12), 1), 56);
  const today = options.today ?? todayUtc();
  const since = addDays(weekOf(today), -7 * (count - 1));
  const weeks = Array.from({ length: count }, (_, index) =>
    addDays(since, 7 * index),
  );

  const signups: Signup[] = (
    await q.query(
      `SELECT actor,day::text AS day,props->>'method' AS method
       FROM analytics_events
       WHERE name='signup_completed' AND actor IS NOT NULL AND day>=$1::date`,
      [since],
    )
  ).rows;
  const actors = [...new Set(signups.map((signup) => signup.actor))];
  const reached = new Map<string, Set<Step>>();
  const activeDays = new Map<string, Set<string>>();
  if (actors.length) {
    const byEvent = new Map(
      Object.entries(STEP_EVENTS).map(([step, name]) => [name, step as Step]),
    );
    for (const row of (
      await q.query(
        `SELECT DISTINCT actor,name FROM analytics_events
         WHERE actor=ANY($1::text[]) AND name=ANY($2::text[])`,
        [actors, Object.values(STEP_EVENTS)],
      )
    ).rows) {
      const step = byEvent.get(row.name)!;
      if (!reached.has(row.actor)) reached.set(row.actor, new Set());
      reached.get(row.actor)!.add(step);
    }
    for (const row of (
      await q.query(
        `SELECT actor,day::text AS day FROM analytics_active_days
         WHERE actor=ANY($1::text[])`,
        [actors],
      )
    ).rows) {
      if (!activeDays.has(row.actor)) activeDays.set(row.actor, new Set());
      activeDays.get(row.actor)!.add(row.day);
    }
  }

  const daily: DailyRow[] = (
    await q.query(
      `SELECT day::text AS day,name,path,source,detail,count::int AS count
       FROM analytics_daily WHERE day>=$1::date`,
      [since],
    )
  ).rows;
  const visitorsByWeek = new Map<string, number>();
  const pages = new Map<string, number>();
  const sources = new Map<string, { visits: number; signups: number }>();
  const methods = new Map<string, number>();
  const activity = new Map<string, Record<string, number>>(
    weeks.map((week) => [week, {}]),
  );
  for (const row of daily) {
    const week = weekOf(row.day);
    const counts = activity.get(week);
    if (counts) counts[row.name] = (counts[row.name] ?? 0) + row.count;
    if (row.name === "page_view") {
      visitorsByWeek.set(week, (visitorsByWeek.get(week) ?? 0) + row.count);
      pages.set(row.path, (pages.get(row.path) ?? 0) + row.count);
    }
    if (row.name === "page_view" || row.name === "signup_completed") {
      const key = row.source || "(direct)";
      const entry = sources.get(key) ?? { visits: 0, signups: 0 };
      if (row.name === "page_view") entry.visits += row.count;
      else entry.signups += row.count;
      sources.set(key, entry);
    }
    if (row.name === "signup_completed")
      methods.set(row.detail, (methods.get(row.detail) ?? 0) + row.count);
  }
  const activeByWeek = new Map<string, number>(
    (
      await q.query(
        `SELECT date_trunc('week',day)::date::text AS week,
                count(DISTINCT actor)::int AS accounts
         FROM analytics_active_days WHERE day>=$1::date GROUP BY 1`,
        [since],
      )
    ).rows.map((row: any) => [row.week, row.accounts]),
  );
  const agentClients = (
    await q.query(
      `SELECT props->>'client' AS client,count(*)::int AS connections,
              count(DISTINCT actor)::int AS accounts
       FROM analytics_events
       WHERE name='agent_connected' AND day>=$1::date
       GROUP BY 1 ORDER BY 2 DESC,1`,
      [since],
    )
  ).rows;
  const allTime = (
    await q.query(
      `SELECT name,sum(count)::bigint::text AS count,min(day)::text AS since
       FROM analytics_daily GROUP BY name ORDER BY name`,
    )
  ).rows;

  return {
    generatedAt: new Date().toISOString(),
    today,
    since,
    weeks: count,
    definitions: DEFINITIONS,
    funnel: funnelWeeks(weeks, signups, reached, visitorsByWeek),
    sources: [...sources.entries()]
      .map(([source, entry]) => ({
        source,
        ...entry,
        signupRate: rate(entry.signups, entry.visits),
      }))
      .sort((a, b) => b.signups - a.signups || b.visits - a.visits)
      .slice(0, 50),
    pages: [...pages.entries()]
      .map(([path, visits]) => ({ path, visits }))
      .sort((a, b) => b.visits - a.visits),
    recipients: recipientFunnel(weeks, daily),
    signupMethods: [...methods.entries()]
      .map(([method, signups]) => ({ method, signups }))
      .sort((a, b) => b.signups - a.signups),
    agentClients,
    retention: retentionCohorts(weeks, signups, activeDays, today),
    activity: weeks.map((week) => {
      const counts = activity.get(week) ?? {};
      return {
        week,
        activeAccounts: activeByWeek.get(week) ?? 0,
        pageViews: counts.page_view ?? 0,
        signups: counts.signup_completed ?? 0,
        agentConnections: counts.agent_connected ?? 0,
        saves: counts.work_saved ?? 0,
        shares: counts.share_created ?? 0,
        sharesOpened: counts.share_opened ?? 0,
        notes: counts.note_added ?? 0,
        enterpriseRequests: counts.enterprise_request ?? 0,
      };
    }),
    totals: {
      allTime: Object.fromEntries(
        allTime.map((row: any) => [row.name, Number(row.count)]),
      ),
      countingSince: allTime.reduce(
        (first: string | null, row: any) =>
          !first || row.since < first ? row.since : first,
        null,
      ),
    },
  };
}

export type MetricsReport = Awaited<ReturnType<typeof metricsReport>>;

// ---------------------------------------------------------------------------
// Routes.

const asset = (name: string) =>
  readFile(new URL(`./ops-metrics/${name}`, import.meta.url), "utf8");

export function registerOpsMetrics(app: FastifyInstance) {
  app.get("/api/ops/metrics", async (req) => {
    authorizeOpsStatus(req.headers.authorization);
    const { weeks } = z
      .object({ weeks: z.coerce.number().int().min(1).max(56).default(12) })
      .parse(req.query ?? {});
    return metricsReport({ weeks });
  });
  // The page carries no data: it asks for the token (kept in this tab's
  // sessionStorage only) and reads the JSON above. Script and styles are
  // files of this origin, as the app's CSP requires.
  const page =
    (name: string, type: string) => async (_req: any, reply: any) => {
      if (!config.OPS_STATUS_TOKEN) throw missing();
      return reply.type(type).send(await asset(name));
    };
  app.get("/ops/metrics", page("index.html", "text/html; charset=utf-8"));
  app.get(
    "/ops/metrics.js",
    page("metrics.js", "text/javascript; charset=utf-8"),
  );
  app.get("/ops/metrics.css", page("metrics.css", "text/css; charset=utf-8"));
}
