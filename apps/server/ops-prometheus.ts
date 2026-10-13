import { db } from "./db.ts";
import { workerSlots } from "./html.ts";
import { counterTotals, eventLoopDelayWindow } from "./runtime-stats.ts";

/*
 * Runtime metrics in the Prometheus text format (version 0.0.4) for the
 * operator's scraper: GET /api/ops/metrics/prometheus with the ops token
 * (metrics.ts). Route patterns and status codes only, never URLs, ids or
 * user data. Product metrics stay the JSON at /api/ops/metrics.
 */

// Seconds; the upper bounds of the request duration histogram.
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

type Series = { count: number; sum: number; buckets: number[] };
const requests = new Map<string, Series>();

/** The labels of one request: method, route pattern (or "unmatched") and status. */
const key = (method: string, route: string, status: number) => JSON.stringify([method, route, String(status)]);

/** Record one finished request (request-log.ts). */
export function recordRequest(method: string, route: string, status: number, seconds: number) {
  const id = key(method, route, status);
  let series = requests.get(id);
  if (!series) requests.set(id, (series = { count: 0, sum: 0, buckets: DURATION_BUCKETS.map(() => 0) }));
  series.count++;
  series.sum += seconds;
  DURATION_BUCKETS.forEach((bound, index) => {
    if (seconds <= bound) series.buckets[index]!++;
  });
}

// A label value in the exposition format: backslash, quote and newline escaped.
const label = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (pairs: Record<string, string>) =>
  `{${Object.entries(pairs)
    .map(([name, value]) => `${name}="${label(value)}"`)
    .join(",")}}`;

// Each scrape reads the event-loop delay since the previous scrape.
const loop = eventLoopDelayWindow();

/** Webhook deliveries waiting to go out: all pending, and those already due. */
async function webhookBacklog() {
  try {
    const {
      rows: [row],
    } = await db.query(
      `SELECT count(*)::int AS pending, count(*) FILTER (WHERE next_attempt_at<=now())::int AS due
       FROM webhook_deliveries WHERE state='pending'`,
    );
    return { pending: Number(row?.pending ?? 0), due: Number(row?.due ?? 0) };
  } catch {
    return null;
  }
}

export async function prometheusText() {
  const out: string[] = [];
  const metric = (name: string, type: string, help: string, samples: Array<[Record<string, string>, number]>) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [pairs, value] of samples)
      out.push(`${name}${Object.keys(pairs).length ? labels(pairs) : ""} ${Number.isFinite(value) ? value : 0}`);
  };

  const entries = [...requests].map(([id, series]) => {
    const [method, route, status] = JSON.parse(id) as [string, string, string];
    return { pairs: { method, route, status }, series };
  });
  metric(
    "polka_http_requests_total",
    "counter",
    "Requests answered, by method, route pattern and status.",
    entries.map(({ pairs, series }) => [pairs, series.count]),
  );
  out.push(
    "# HELP polka_http_request_duration_seconds Time to answer a request, by method, route pattern and status.",
    "# TYPE polka_http_request_duration_seconds histogram",
  );
  for (const { pairs, series } of entries) {
    DURATION_BUCKETS.forEach((bound, index) =>
      out.push(
        `polka_http_request_duration_seconds_bucket${labels({ ...pairs, le: String(bound) })} ${series.buckets[index]}`,
      ),
    );
    out.push(
      `polka_http_request_duration_seconds_bucket${labels({ ...pairs, le: "+Inf" })} ${series.count}`,
      `polka_http_request_duration_seconds_sum${labels(pairs)} ${Math.round(series.sum * 1e6) / 1e6}`,
      `polka_http_request_duration_seconds_count${labels(pairs)} ${series.count}`,
    );
  }

  metric("polka_db_pool_max", "gauge", "Connections the database pool may open.", [[{}, db.options.max ?? 0]]);
  metric("polka_db_pool_connections", "gauge", "Database pool connections by state.", [
    [{ state: "total" }, db.totalCount],
    [{ state: "idle" }, db.idleCount],
    [{ state: "waiting" }, db.waitingCount],
  ]);

  const delay = loop.read();
  metric(
    "polka_event_loop_delay_seconds",
    "gauge",
    "Event-loop delay since the previous scrape, beyond the sampling period.",
    [
      [{ stat: "mean" }, delay.mean / 1000],
      [{ stat: "p99" }, delay.p99 / 1000],
      [{ stat: "max" }, delay.max / 1000],
    ],
  );

  const memory = process.memoryUsage();
  metric("process_resident_memory_bytes", "gauge", "Resident memory of the process.", [[{}, memory.rss]]);
  metric("nodejs_heap_used_bytes", "gauge", "V8 heap in use.", [[{}, memory.heapUsed]]);
  metric("nodejs_heap_total_bytes", "gauge", "V8 heap reserved.", [[{}, memory.heapTotal]]);
  metric("process_uptime_seconds", "gauge", "Seconds since the process started.", [[{}, Math.round(process.uptime())]]);

  const workers = workerSlots();
  metric("polka_worker_slots", "gauge", "Inspection worker slots: the limit, running and queued jobs.", [
    [{ state: "limit" }, workers.limit],
    [{ state: "running" }, workers.running],
    [{ state: "waiting" }, workers.waiting],
  ]);

  const backlog = await webhookBacklog();
  if (backlog) {
    metric("polka_webhook_deliveries_pending", "gauge", "Webhook deliveries waiting to be sent.", [
      [{}, backlog.pending],
    ]);
    metric("polka_webhook_deliveries_due", "gauge", "Pending webhook deliveries whose next attempt is due.", [
      [{}, backlog.due],
    ]);
  }

  metric(
    "polka_events_total",
    "counter",
    "Events the code counts where a cache or a limit decides something.",
    [...counterTotals()].map(([name, value]) => [{ name }, value]),
  );
  return out.join("\n") + "\n";
}
