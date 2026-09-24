// The recipient prompt's count (apps/server/recipient-cta.ts, analytics.ts,
// migration 035): anonymous rows for guests with a browser only, the report's
// «Получатели → регистрации» block, and nothing that names a link or a person.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { flushAnalytics } from "../apps/server/analytics.ts";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { metricsReport, recipientFunnel } from "../apps/server/metrics.ts";
import { s3 } from "../apps/server/storage.ts";
import { formatReport } from "../scripts/metrics.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const HUMAN =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const address = () =>
  `2001:db8:c7::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

after(async () => {
  await flushAnalytics();
  await app.close();
  await db.end();
  s3.destroy();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/recipient-cta",
    remoteAddress: address(),
    headers: { origin, "user-agent": HUMAN, ...headers },
    payload: body as any,
  });

const counted = async (name: string, detail: string) => {
  await flushAnalytics();
  const { rows } = await db.query(
    `SELECT coalesce(sum(count),0)::int AS n FROM analytics_daily WHERE name=$1 AND detail=$2 AND path='/s'`,
    [name, detail],
  );
  return rows[0].n as number;
};

test("a guest's view and press are counted anonymously; bots, signed-in viewers and junk are not", async () => {
  const before = {
    bar: await counted("recipient_cta_view", "bar"),
    card: await counted("recipient_cta_view", "card"),
    remix: await counted("recipient_cta_click", "remix"),
  };
  for (const body of [
    { event: "view", surface: "bar" },
    { event: "view", surface: "card" },
    { event: "click", action: "remix" },
  ]) {
    const response = await post(body);
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.body, "");
  }
  // A bot's load, a signed-in viewer's load: 204, nothing written.
  assert.equal((await post({ event: "view", surface: "bar" }, { "user-agent": "curl/8.7.1" })).statusCode, 204);
  assert.equal(
    (await post({ event: "view", surface: "bar" }, { cookie: "polka_session=whatever" })).statusCode,
    204,
  );
  // Anything beyond the two enumerated words is refused.
  for (const bad of [
    { event: "view", surface: "modal" },
    { event: "click", action: "buy" },
    { event: "click", action: "try", token: "A".repeat(43) },
    { event: "view", surface: "bar", title: "Отчёт" },
    { event: "open" },
    ["view"],
  ])
    assert.equal((await post(bad)).statusCode, 400, JSON.stringify(bad));
  // A browser POST from elsewhere is refused before anything is counted.
  assert.equal(
    (await post({ event: "view", surface: "bar" }, { origin: "https://attacker.invalid" })).statusCode,
    403,
  );
  assert.equal(await counted("recipient_cta_view", "bar"), before.bar + 1);
  assert.equal(await counted("recipient_cta_view", "card"), before.card + 1);
  assert.equal(await counted("recipient_cta_click", "remix"), before.remix + 1);
  const { rows } = await db.query(
    `SELECT actor,subject,props FROM analytics_events
     WHERE name IN ('recipient_cta_view','recipient_cta_click') ORDER BY occurred_at DESC LIMIT 3`,
  );
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.actor, null);
    assert.equal(row.subject, null);
    assert.deepEqual(Object.keys(row.props).length, 1);
  }
  assert.deepEqual(
    rows.map((row) => row.props).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [{ action: "remix" }, { surface: "bar" }, { surface: "card" }],
  );
});

test("the report's «Получатели → регистрации» block: counts by week and ratios", async () => {
  const report = await metricsReport({ weeks: 2 });
  assert.deepEqual(report.recipients.actions, ["try", "remix", "copy_phrase", "yandex", "email"]);
  assert.equal(report.recipients.weeks.length, 2);
  const week = report.recipients.weeks.at(-1)!;
  for (const key of ["week", "opened", "barViews", "cardViews", "clicks", "clicksTotal", "signups", "conversion"])
    assert.ok(key in week, key);
  assert.ok(report.recipients.total.barViews >= 1);
  assert.ok(report.recipients.total.clicks.remix >= 1);
  assert.match(report.definitions.recipients, /ref:share/);
  assert.match(formatReport(report), /Получатели → регистрации/);

  // Pure: only recipient rows count, and sign-ups only from the share refs.
  const weeks = ["2026-09-14", "2026-09-21"];
  const daily = [
    { day: "2026-09-15", name: "share_opened", source: "", detail: "", count: 40 },
    { day: "2026-09-16", name: "recipient_cta_view", source: "", detail: "bar", count: 50 },
    { day: "2026-09-16", name: "recipient_cta_view", source: "", detail: "card", count: 10 },
    { day: "2026-09-17", name: "recipient_cta_click", source: "", detail: "try", count: 4 },
    { day: "2026-09-17", name: "recipient_cta_click", source: "", detail: "email", count: 1 },
    { day: "2026-09-17", name: "recipient_cta_click", source: "", detail: "bogus", count: 9 },
    { day: "2026-09-18", name: "signup_completed", source: "ref:share", detail: "email", count: 1 },
    { day: "2026-09-18", name: "signup_completed", source: "ref:share-remix", detail: "yandex", count: 1 },
    { day: "2026-09-18", name: "signup_completed", source: "ref:habr", detail: "email", count: 7 },
    { day: "2026-09-22", name: "recipient_cta_view", source: "", detail: "bar", count: 8 },
    { day: "2026-08-01", name: "recipient_cta_view", source: "", detail: "bar", count: 999 },
  ];
  const funnel = recipientFunnel(weeks, daily);
  assert.deepEqual(funnel.weeks[0], {
    week: "2026-09-14",
    opened: 40,
    barViews: 50,
    cardViews: 10,
    clicks: { try: 4, remix: 0, copy_phrase: 0, yandex: 0, email: 1 },
    clicksTotal: 5,
    signups: 2,
    conversion: { barToCard: 0.2, cardToClick: 0.5, clickToSignup: 0.4, barToSignup: 0.04 },
  });
  assert.equal(funnel.weeks[1]!.barViews, 8);
  assert.equal(funnel.weeks[1]!.conversion.barToCard, 0);
  assert.equal(funnel.weeks[1]!.conversion.cardToClick, null);
  assert.equal(funnel.total.barViews, 58);
  assert.equal(funnel.total.signups, 2);
});
