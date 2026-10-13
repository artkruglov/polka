// Webhooks of a shelf (docs/specs/WEBHOOKS.md; off unless WEBHOOKS=on). The
// owner of a personal shelf, or an admin of a department shelf, registers
// public HTTPS addresses and the events to send there. The events are the
// shelf's rows of audit_outbox, the journal the agents' feed reads
// (GET /api/v1/events), and the body is the same event JSON: ids and times,
// never the content of a work or a link's secret.
//
// Two loops run in the app process (main.ts), each safe with several
// instances: the dispatcher reads the journal in commit order by one cursor
// (a locked row: one instance at a time) and writes a delivery per event and
// address; the sender claims due deliveries with SKIP LOCKED, at most two in
// flight per address, POSTs them signed (webhook-send.ts) from a small pool
// and plans the next attempt with a growing pause. An address failing again
// and again is paused as a whole (circuit breaker), so it does not take the
// pool from the others; after three days of failures it is switched off and
// the person who registered it gets a letter.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  MAX_WEBHOOKS_PER_SHELF,
  WEBHOOK_EVENTS,
  createWebhookInput,
  updateWebhookInput,
  type Webhook,
  type WebhookDelivery,
} from "../../packages/contracts/webhooks.ts";
import { EVENT_COLUMNS_SQL, EVENT_FROM_SQL, eventDTO } from "./agent-events.ts";
import { limitAttempts } from "./auth.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { SETTLED_SQL, auditFeedHead } from "./extension-feed.ts";
import { log } from "./log.ts";
import { sendMail } from "./mailer.ts";
import { lockShelf } from "./shelves.ts";
import {
  SNIPPET_CHARS,
  assertWebhookUrl,
  newWebhookSecret,
  openWebhookSecret,
  sealWebhookSecret,
  secretHint,
  webhookNetwork,
  webhookRequest,
  type SendResult,
} from "./webhook-send.ts";

type Actor = { id: string; tenant: string; provisional?: boolean };

/** Pauses before the 2nd…8th attempt; after the 8th a delivery has failed. */
export const RETRY_DELAYS_SECONDS = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600, 12 * 3600, 24 * 3600] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
/** An address is switched off after this many failed attempts in a row over at least this long. */
export const DISABLE_AFTER_FAILURES = 8;
export const DISABLE_AFTER_HOURS = 72;
/** After this many failures in a row the address waits as a whole: 1, 2, 4… minutes, at most an hour. */
export const BREAKER_AFTER_FAILURES = 3;
const BREAKER_MAX_MINUTES = 60;
/** Attempts in flight at once: per address (one while it is failing), and in all. */
export const MAX_IN_FLIGHT_PER_ENDPOINT = 2;
export const SEND_CONCURRENCY = 10;
/** And per shelf: a shelf of slow (but answering) receivers cannot fill the pool. */
export const MAX_IN_FLIGHT_PER_SHELF = 4;
/** Deliveries one address may have waiting; events beyond it are counted and not queued. */
export const MAX_PENDING_PER_ENDPOINT = 1000;
/** Events older than this are not sent: a shelf that turned webhooks on late gets no backlog. */
const STALE_HOURS = 24;
/** A delivery still waiting after this long is given up (its shelf archived, its creator gone…). */
const PENDING_EXPIRE_DAYS = 7;
/** The delivery log keeps finished deliveries this long. */
const LOG_DAYS = 30;
/** While an attempt is in flight its row is leased this long, so a crash retries it. */
const LEASE_MINUTES = 5;
const PINGS_PER_HOUR = 10;
const WRITES_PER_HOUR = 30;

const enabled = (actor: Actor) => {
  if (config.WEBHOOKS !== "on") throw missing();
  // A provisional shelf may yet be merged into another: nothing points outside until it is claimed.
  if (actor.provisional)
    throw new Problem(403, "forbidden", "Вебхуки доступны после того, как вы закрепите полку за собой.");
};

/** The owner of a personal shelf, or an admin of a department shelf (TEAM_SHELVES=on). */
const lockManager = (c: PoolClient, actor: Actor) => lockShelf(c, actor, "admin");

/**
 * The person who answers for a webhook is still an active admin (the owner,
 * on a personal shelf) and not disabled. The triggers of migration 071 switch
 * it off when that changes; this check covers the moment in between.
 */
const ANSWERED_SQL = `EXISTS(SELECT 1 FROM tenant_members member
  JOIN accounts creator ON creator.id=member.account_id
  WHERE member.tenant_id=w.tenant_id AND member.account_id=w.created_by AND member.state='active'
    AND member.role IN ('admin','owner') AND NOT creator.disabled AND creator.deletion_requested_at IS NULL)`;

const webhookDTO = (row: any): Webhook => ({
  id: row.id,
  url: row.url,
  description: row.description,
  events: row.events,
  status: row.status,
  disabledReason: row.disabled_reason ?? null,
  secretHint: row.secret_hint,
  createdAt: new Date(row.created_at).toISOString(),
  lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
  lastFailureAt: row.last_failure_at ? new Date(row.last_failure_at).toISOString() : null,
  consecutiveFailures: row.consecutive_failures,
  pausedUntil:
    row.paused_until && new Date(row.paused_until) > new Date() ? new Date(row.paused_until).toISOString() : null,
  skippedEvents: row.skipped_events,
});

const deliveryDTO = (row: any): WebhookDelivery => ({
  id: row.id,
  eventId: row.event_id,
  action: row.action,
  state: row.state,
  attempts: row.attempts,
  lastStatus: row.last_status ?? null,
  lastError: row.last_error ?? null,
  responseSnippet: row.response_snippet ?? null,
  createdAt: new Date(row.created_at).toISOString(),
  lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
  nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
});

async function endpointOf(c: PoolClient, actor: Actor, id: string) {
  const {
    rows: [row],
  } = await c.query("SELECT * FROM webhook_endpoints WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [id, actor.tenant]);
  if (!row) throw missing();
  return row;
}

/**
 * Before anything costly (a rate-limit slot, a DNS lookup): the actor may
 * manage this shelf's webhooks, and the webhook, when named, is the shelf's.
 */
async function authorize(actor: Actor, id?: string) {
  await transaction(async (c) => {
    await lockShelf(c, actor, "admin", "SHARE");
    if (id) {
      const { rowCount } = await c.query("SELECT 1 FROM webhook_endpoints WHERE id=$1 AND tenant_id=$2", [
        id,
        actor.tenant,
      ]);
      if (!rowCount) throw missing();
    }
  });
}

const limitWrites = (actor: Actor) =>
  limitAttempts(`webhook-write:${actor.tenant}:${actor.id}`, WRITES_PER_HOUR, "1 hour");

async function assertRoom(c: Pick<PoolClient, "query">, actor: Actor) {
  const {
    rows: [count],
  } = await c.query("SELECT count(*)::int AS n FROM webhook_endpoints WHERE tenant_id=$1", [actor.tenant]);
  if (count.n >= MAX_WEBHOOKS_PER_SHELF)
    throw new Problem(413, "quota", `На полке уже ${MAX_WEBHOOKS_PER_SHELF} вебхуков. Удалите ненужный.`);
}

// The owner's actions ---------------------------------------------------------

export async function listWebhooks(actor: Actor) {
  enabled(actor);
  return transaction(async (c) => {
    await lockShelf(c, actor, "admin", "SHARE");
    const { rows } = await c.query("SELECT * FROM webhook_endpoints WHERE tenant_id=$1 ORDER BY created_at,id", [
      actor.tenant,
    ]);
    return { items: rows.map(webhookDTO), events: WEBHOOK_EVENTS };
  });
}

export async function createWebhook(actor: Actor, body: unknown) {
  enabled(actor);
  const input = createWebhookInput.parse(body);
  await authorize(actor);
  // A full shelf is told so before the name is looked up.
  await assertRoom(db, actor);
  await limitWrites(actor);
  // Before anything is stored: an address that resolves inside is refused now.
  const url = await assertWebhookUrl(input.url);
  const secret = newWebhookSecret();
  const id = randomUUID();
  return transaction(async (c) => {
    await lockManager(c, actor);
    await assertRoom(c, actor);
    const {
      rows: [row],
    } = await c.query(
      `INSERT INTO webhook_endpoints(id,tenant_id,created_by,url,description,events,secret_enc,secret_hint)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        id,
        actor.tenant,
        actor.id,
        url,
        input.description,
        input.events,
        sealWebhookSecret(secret, id),
        secretHint(secret),
      ],
    );
    return { webhook: webhookDTO(row), secret };
  });
}

export async function updateWebhook(actor: Actor, id: string, body: unknown) {
  enabled(actor);
  const input = updateWebhookInput.parse(body);
  await authorize(actor, id);
  await limitWrites(actor);
  const url = input.url === undefined ? undefined : await assertWebhookUrl(input.url);
  return transaction(async (c) => {
    await lockManager(c, actor);
    const current = await endpointOf(c, actor, id);
    const on = input.enabled ?? current.status === "active";
    const {
      rows: [row],
    } = await c.query(
      `UPDATE webhook_endpoints SET
         url=COALESCE($2,url),description=COALESCE($3,description),events=COALESCE($4,events),
         status=CASE WHEN $5::boolean THEN 'active' ELSE 'disabled' END,
         disabled_reason=CASE WHEN $5::boolean THEN NULL
                              WHEN status='disabled' THEN disabled_reason ELSE 'owner' END,
         -- Switched on again: a fresh start, failures are forgotten, and
         -- whoever switched it on answers for it from now on.
         consecutive_failures=CASE WHEN $5::boolean AND status='disabled' THEN 0 ELSE consecutive_failures END,
         failing_since=CASE WHEN $5::boolean AND status='disabled' THEN NULL ELSE failing_since END,
         paused_until=CASE WHEN $5::boolean AND status='disabled' THEN NULL ELSE paused_until END,
         created_by=CASE WHEN $5::boolean AND status='disabled' THEN $6 ELSE created_by END,
         updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, url ?? null, input.description ?? null, input.events ?? null, on, actor.id],
    );
    if (!on) await abandonPending(c, id, "endpoint_disabled");
    // Events no longer asked for are not sent, even those already waiting.
    else if (input.events)
      await c.query(
        `UPDATE webhook_deliveries SET state='failed',next_attempt_at=NULL,leased_until=NULL,last_error='event_removed'
         WHERE endpoint_id=$1 AND state='pending' AND action<>ALL($2::text[])`,
        [id, input.events],
      );
    return { webhook: webhookDTO(row) };
  });
}

export async function deleteWebhook(actor: Actor, id: string) {
  enabled(actor);
  return transaction(async (c) => {
    await lockManager(c, actor);
    await endpointOf(c, actor, id);
    // The delivery log goes with it (ON DELETE CASCADE).
    await c.query("DELETE FROM webhook_endpoints WHERE id=$1", [id]);
    return { ok: true as const };
  });
}

/** A new secret at once; the old one stops signing with this commit. */
export async function rotateWebhookSecret(actor: Actor, id: string) {
  enabled(actor);
  const secret = newWebhookSecret();
  return transaction(async (c) => {
    await lockManager(c, actor);
    await endpointOf(c, actor, id);
    const {
      rows: [row],
    } = await c.query(
      "UPDATE webhook_endpoints SET secret_enc=$2,secret_hint=$3,updated_at=now() WHERE id=$1 RETURNING *",
      [id, sealWebhookSecret(secret, id), secretHint(secret)],
    );
    return { webhook: webhookDTO(row), secret };
  });
}

export async function listWebhookDeliveries(actor: Actor, id: string) {
  enabled(actor);
  return transaction(async (c) => {
    await lockShelf(c, actor, "admin", "SHARE");
    const {
      rows: [endpoint],
    } = await c.query("SELECT id FROM webhook_endpoints WHERE id=$1 AND tenant_id=$2", [id, actor.tenant]);
    if (!endpoint) throw missing();
    const { rows } = await c.query(
      "SELECT * FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50",
      [id],
    );
    return { items: rows.map(deliveryDTO) };
  });
}

/**
 * «Проверить»: one `ping` sent now, whatever the address's state, with the
 * answer in the log. No retries, and it does not count toward switching off.
 */
export async function pingWebhook(actor: Actor, id: string) {
  enabled(actor);
  const { endpoint, delivery } = await transaction(async (c) => {
    await lockManager(c, actor);
    const endpoint = await endpointOf(c, actor, id);
    // Per person and shelf, after the check that they may: a stranger spends nobody's allowance.
    await limitAttempts(`webhook-ping:${actor.tenant}:${actor.id}`, PINGS_PER_HOUR, "1 hour");
    const deliveryId = randomUUID();
    const eventId = `ping:${deliveryId}`;
    const payload = { id: eventId, action: "ping", shelfId: actor.tenant, at: new Date().toISOString() };
    const {
      rows: [delivery],
    } = await c.query(
      `INSERT INTO webhook_deliveries(id,endpoint_id,tenant_id,event_id,action,payload,state,attempts,last_attempt_at)
       VALUES($1,$2,$3,$4,'ping',$5,'failed',1,now()) RETURNING *`,
      [deliveryId, id, actor.tenant, eventId, payload],
    );
    return { endpoint, delivery };
  });
  const result = await send(endpoint, delivery);
  const {
    rows: [row],
  } = await db.query(
    `UPDATE webhook_deliveries SET state=$2,last_status=$3,last_error=$4,response_snippet=$5
     WHERE id=$1 RETURNING *`,
    [delivery.id, result.ok ? "delivered" : "failed", result.status, result.error, result.snippet],
  );
  return { delivery: deliveryDTO(row ?? delivery) };
}

// The loops -------------------------------------------------------------------

async function abandonPending(c: Pick<PoolClient, "query">, endpointId: string, reason: string) {
  await c.query(
    `UPDATE webhook_deliveries SET state='failed',next_attempt_at=NULL,leased_until=NULL,last_error=$2
     WHERE endpoint_id=$1 AND state='pending'`,
    [endpointId, reason],
  );
}

/** One attempt. The endpoint row gives the address and the sealed secret (bound to its id). */
async function send(
  endpoint: { id: string; url: string; secret_enc: Buffer },
  delivery: { id: string; action: string; payload: unknown },
): Promise<SendResult> {
  let secret: string;
  try {
    secret = openWebhookSecret(endpoint.secret_enc, endpoint.id);
  } catch {
    // LINK_KEY changed, or the row was tampered with: nothing is sent unsigned.
    return { ok: false, status: null, error: "secret", snippet: null };
  }
  const { transport, resolver } = webhookNetwork();
  try {
    return await transport(webhookRequest(endpoint.url, secret, delivery), resolver);
  } catch {
    return { ok: false, status: null, error: "connection", snippet: null };
  }
}

const isAfter = (a: { tx: string; id: string }, b: { tx: string; id: string }) => {
  const tx = BigInt(a.tx) - BigInt(b.tx);
  return tx > 0n || (tx === 0n && BigInt(a.id) > BigInt(b.id));
};

/**
 * One page of the dispatcher: journal rows after the cursor, up to the
 * settled end, of the shelves that have an active address; a delivery for
 * every address that asked for the action, existed when it happened and
 * still has someone answering for it. `more`: a full page, read again.
 */
export async function dispatchWebhookEvents(limit = 200): Promise<{ created: number; more: boolean }> {
  if (config.WEBHOOKS !== "on") return { created: 0, more: false };
  return transaction(async (c) => {
    const {
      rows: [cursor],
    } = await c.query(
      `SELECT tx::text AS tx,event_id::text AS id,tx>pg_current_xact_id() AS ahead
         FROM webhook_dispatch_cursor FOR UPDATE SKIP LOCKED`,
    );
    // Another instance is dispatching.
    if (!cursor) return { created: 0, more: false };
    const head = await auditFeedHead();
    // The first run starts at the end: nothing that happened before is sent.
    if (cursor.tx === null) {
      await c.query("UPDATE webhook_dispatch_cursor SET tx=$1::xid8,event_id=$2", [head.tx, head.id]);
      return { created: 0, more: false };
    }
    // Transaction numbers of another cluster (a logical dump restored into a
    // new one starts them again): the cursor would wait ahead forever.
    if (cursor.ahead) {
      log.warn({ event: "webhooks.cursor_reset", reason: "ahead_of_cluster" });
      await c.query("UPDATE webhook_dispatch_cursor SET tx=$1::xid8,event_id=$2", [head.tx, head.id]);
      return { created: 0, more: false };
    }
    let from = { tx: cursor.tx as string, id: cursor.id as string };
    // After a long pause (WEBHOOKS was off) nothing older than a day is sent:
    // jump to the first row newer than that instead of walking the backlog.
    const {
      rows: [first],
    } = await c.query(
      `SELECT e.created_at<now()-$3*interval '1 hour' AS stale FROM audit_outbox e
        WHERE (COALESCE(e.tx_id,'0'::xid8),e.id)>($1::xid8,$2::bigint)
        ORDER BY COALESCE(e.tx_id,'0'::xid8),e.id LIMIT 1`,
      [from.tx, from.id, STALE_HOURS],
    );
    if (first?.stale) {
      const {
        rows: [fresh],
      } = await c.query(
        `SELECT COALESCE(e.tx_id,'0'::xid8)::text AS tx,(e.id-1)::text AS id FROM audit_outbox e
          WHERE (COALESCE(e.tx_id,'0'::xid8),e.id)>($1::xid8,$2::bigint)
            AND e.created_at>=now()-$3*interval '1 hour'
          ORDER BY COALESCE(e.tx_id,'0'::xid8),e.id LIMIT 1`,
        [from.tx, from.id, STALE_HOURS],
      );
      from = fresh && !isAfter(fresh, head) ? fresh : head;
      log.warn({ event: "webhooks.cursor_skipped_stale" });
    }
    const { rows } = await c.query(
      `SELECT ${EVENT_COLUMNS_SQL}
       ${EVENT_FROM_SQL}
       WHERE e.action=ANY($1::text[])
         AND (COALESCE(e.tx_id,'0'::xid8),e.id)>($2::xid8,$3::bigint)
         AND (COALESCE(e.tx_id,'0'::xid8),e.id)<=($4::xid8,$5::bigint)
         AND ${SETTLED_SQL}
         AND EXISTS(SELECT 1 FROM webhook_endpoints w WHERE w.tenant_id=e.tenant_id AND w.status='active')
       ORDER BY COALESCE(e.tx_id,'0'::xid8),e.id
       LIMIT $6`,
      [WEBHOOK_EVENTS, from.tx, from.id, head.tx, head.id, limit],
    );
    let created = 0;
    for (const row of rows) {
      if (Date.now() - new Date(row.created_at).getTime() > STALE_HOURS * 3600_000) continue;
      const event = eventDTO(row);
      const {
        rows: [result],
      } = await c.query(
        `WITH targets AS (
           SELECT w.id,w.tenant_id,
                  (SELECT count(*) FROM webhook_deliveries waiting
                    WHERE waiting.endpoint_id=w.id AND waiting.state='pending') AS waiting
             FROM webhook_endpoints w
            WHERE w.tenant_id=$1 AND w.status='active' AND $3=ANY(w.events) AND w.created_at<=$5
              AND ${ANSWERED_SQL}
         ),
         skipped AS (
           UPDATE webhook_endpoints w SET skipped_events=w.skipped_events+1
             FROM targets t WHERE w.id=t.id AND t.waiting>=$6 RETURNING w.id
         ),
         queued AS (
           INSERT INTO webhook_deliveries(id,endpoint_id,tenant_id,event_id,action,payload,next_attempt_at)
           SELECT gen_random_uuid(),t.id,t.tenant_id,$2,$3,$4,now() FROM targets t WHERE t.waiting<$6
           ON CONFLICT (endpoint_id,event_id) DO NOTHING
           RETURNING id
         )
         SELECT (SELECT count(*) FROM queued)::int AS queued,(SELECT count(*) FROM skipped)::int AS skipped`,
        [
          row.tenant_id,
          event.id,
          event.action,
          { ...event, shelfId: row.tenant_id },
          row.created_at,
          MAX_PENDING_PER_ENDPOINT,
        ],
      );
      created += result.queued;
      if (result.skipped) log.warn({ event: "webhooks.queue_full", action: event.action });
    }
    const last = rows.at(-1);
    const more = rows.length === limit;
    // A short page holds every row up to the settled end: move past it.
    const next = more ? { tx: last.tx, id: last.id } : head;
    await c.query("UPDATE webhook_dispatch_cursor SET tx=$1::xid8,event_id=$2", [next.tx, next.id]);
    return { created, more };
  });
}

/** Pages until the journal is caught up (or a bound, for the next tick). */
export async function dispatchAllWebhookEvents(maxPages = 25) {
  let created = 0;
  for (let page = 0; page < maxPages; page++) {
    const result = await dispatchWebhookEvents();
    created += result.created;
    if (!result.more) break;
  }
  return created;
}

/**
 * Deliveries due now, claimed for one attempt each. Several instances take
 * different rows; an address has at most MAX_IN_FLIGHT_PER_ENDPOINT attempts
 * in flight (one while it is failing) and a shelf MAX_IN_FLIGHT_PER_SHELF,
 * so one slow receiver cannot take every slot. The caps are counted from
 * leases, not locked: two instances claiming at the same moment may exceed
 * them briefly. An address the breaker paused, a shelf no longer active, and a
 * webhook nobody answers for wait.
 */
async function claimDue(limit: number) {
  if (limit <= 0) return [];
  return transaction(async (c) => {
    const { rows } = await c.query(
      // In flight now, per address and per shelf (the small leased index).
      // Then per address that may send: at most its room of due deliveries
      // (the (endpoint_id, next_attempt_at) index), never a scan of the whole
      // backlog; then at most the shelf's room of those, oldest first.
      `WITH busy AS (
         SELECT endpoint_id,tenant_id,count(*)::int AS n FROM webhook_deliveries
          WHERE state='pending' AND leased_until IS NOT NULL AND leased_until>now()
          GROUP BY endpoint_id,tenant_id
       ),
       shelf_busy AS (SELECT tenant_id,sum(n)::int AS n FROM busy GROUP BY tenant_id),
       senders AS (
         SELECT w.id,w.tenant_id,
                CASE WHEN w.consecutive_failures>=$3 THEN 1 ELSE $2 END-COALESCE(busy.n,0) AS room
           FROM webhook_endpoints w
           JOIN tenants tenant ON tenant.id=w.tenant_id AND tenant.state='active'
                AND ($4::boolean OR tenant.kind='personal')
           LEFT JOIN busy ON busy.endpoint_id=w.id
          WHERE w.status='active' AND (w.paused_until IS NULL OR w.paused_until<=now())
            AND ${ANSWERED_SQL}
            AND EXISTS(SELECT 1 FROM webhook_deliveries due
                        WHERE due.endpoint_id=w.id AND due.state='pending' AND due.next_attempt_at<=now())
       ),
       candidates AS (
         SELECT pick.id,pick.next_attempt_at,s.tenant_id FROM senders s
         CROSS JOIN LATERAL (
           SELECT d.id,d.next_attempt_at FROM webhook_deliveries d
            WHERE d.endpoint_id=s.id AND d.state='pending' AND d.next_attempt_at<=now()
              AND (d.leased_until IS NULL OR d.leased_until<=now())
            ORDER BY d.next_attempt_at,d.id LIMIT GREATEST(s.room,0)
         ) pick
         WHERE s.room>0
       ),
       ranked AS (
         SELECT c.id,c.next_attempt_at,
                row_number() OVER (PARTITION BY c.tenant_id ORDER BY c.next_attempt_at,c.id) AS rank,
                $5-COALESCE(shelf_busy.n,0) AS room
           FROM candidates c LEFT JOIN shelf_busy ON shelf_busy.tenant_id=c.tenant_id
       )
       SELECT d.id FROM webhook_deliveries d
        WHERE d.id IN (SELECT id FROM ranked WHERE rank<=room ORDER BY next_attempt_at LIMIT $1)
        FOR UPDATE OF d SKIP LOCKED`,
      [
        limit,
        MAX_IN_FLIGHT_PER_ENDPOINT,
        BREAKER_AFTER_FAILURES,
        config.TEAM_SHELVES === "on",
        MAX_IN_FLIGHT_PER_SHELF,
      ],
    );
    if (!rows.length) return [];
    const { rows: claimed } = await c.query(
      `UPDATE webhook_deliveries d SET attempts=d.attempts+1,last_attempt_at=now(),
              leased_until=now()+$2*interval '1 minute',next_attempt_at=now()+$2*interval '1 minute'
         FROM webhook_endpoints w
        WHERE d.id=ANY($1::uuid[]) AND w.id=d.endpoint_id
        RETURNING d.*,w.url,w.secret_enc`,
      [rows.map((row) => row.id), LEASE_MINUTES],
    );
    return claimed;
  });
}

/**
 * The endpoint before its deliveries, the order of updateWebhook,
 * abandonPending and the webhooks_lose_creator trigger: the other order could
 * deadlock with them.
 */
const lockEndpoint = (c: PoolClient, id: string) =>
  c.query("SELECT 1 FROM webhook_endpoints WHERE id=$1 FOR UPDATE", [id]);

async function record(delivery: any, result: SendResult) {
  const snippet = result.snippet?.slice(0, SNIPPET_CHARS) ?? null;
  if (result.ok) {
    await transaction(async (c) => {
      await lockEndpoint(c, delivery.endpoint_id);
      const { rowCount } = await c.query(
        `UPDATE webhook_deliveries SET state='delivered',next_attempt_at=NULL,leased_until=NULL,
                last_status=$2,last_error=NULL,response_snippet=$3
         WHERE id=$1 AND state='pending'`,
        [delivery.id, result.status, snippet],
      );
      if (rowCount)
        await c.query(
          `UPDATE webhook_endpoints SET consecutive_failures=0,failing_since=NULL,paused_until=NULL,last_success_at=now()
           WHERE id=$1`,
          [delivery.endpoint_id],
        );
    });
    return;
  }
  const last = delivery.attempts >= MAX_ATTEMPTS;
  const delay = RETRY_DELAYS_SECONDS[Math.min(delivery.attempts, RETRY_DELAYS_SECONDS.length) - 1]!;
  const disabled = await transaction(async (c) => {
    await lockEndpoint(c, delivery.endpoint_id);
    const { rowCount } = await c.query(
      `UPDATE webhook_deliveries SET state=$2,next_attempt_at=CASE WHEN $2='pending' THEN now()+$3*interval '1 second' END,
              leased_until=NULL,last_status=$4,last_error=$5,response_snippet=$6
       WHERE id=$1 AND state='pending'`,
      [delivery.id, last ? "failed" : "pending", delay, result.status, result.error, snippet],
    );
    // Cancelled meanwhile (switched off, events narrowed): not the address's failure.
    if (!rowCount) return null;
    const {
      rows: [endpoint],
    } = await c.query(
      `UPDATE webhook_endpoints SET consecutive_failures=consecutive_failures+1,
              failing_since=COALESCE(failing_since,now()),last_failure_at=now(),
              paused_until=CASE WHEN consecutive_failures+1>=$2
                THEN now()+LEAST(power(2,consecutive_failures+1-$2),$3)*interval '1 minute' END
       WHERE id=$1 RETURNING *`,
      [delivery.endpoint_id, BREAKER_AFTER_FAILURES, BREAKER_MAX_MINUTES],
    );
    if (!endpoint) return null;
    const {
      rows: [off],
    } = await c.query(
      `UPDATE webhook_endpoints SET status='disabled',disabled_reason='failures',updated_at=now()
       WHERE id=$1 AND status='active' AND consecutive_failures>=$2
         AND failing_since<=now()-$3*interval '1 hour'
       RETURNING id,url,tenant_id,created_by`,
      [endpoint.id, DISABLE_AFTER_FAILURES, DISABLE_AFTER_HOURS],
    );
    if (!off) return null;
    await abandonPending(c, off.id, "endpoint_disabled");
    return off;
  });
  if (disabled) {
    log.warn({ event: "webhooks.disabled", webhookId: disabled.id });
    void tellDisabled(disabled).catch(() => log.error({ event: "webhooks.disabled_mail_failed" }));
  }
}

/** A letter to whoever registered the address: Полка stopped sending to it. */
async function tellDisabled(endpoint: { url: string; tenant_id: string; created_by: string }) {
  const {
    rows: [person],
  } = await db.query(
    `SELECT account.email,tenant.kind,tenant.name FROM accounts account, tenants tenant
     WHERE account.id=$1 AND tenant.id=$2 AND account.email IS NOT NULL
       AND NOT account.disabled AND account.deletion_requested_at IS NULL`,
    [endpoint.created_by, endpoint.tenant_id],
  );
  if (!person) return;
  const shelf = person.kind === "team" ? `полки «${person.name}»` : "вашей полки";
  await sendMail({
    to: person.email,
    subject: "Полка: вебхук отключён",
    text: [
      `Полка отключила вебхук ${shelf} на адрес ${new URL(endpoint.url).host}: больше ${DISABLE_AFTER_HOURS / 24} дней все попытки доставки заканчивались ошибкой.`,
      "",
      "Неотправленные события отменены. Проверьте сервер-получатель и включите вебхук снова в настройках полки: история ошибок видна в журнале доставок.",
      "",
      `Настройки: ${config.APP_ORIGIN}/settings#webhooks`,
    ].join("\n"),
  });
}

/**
 * The sender: a pool of SEND_CONCURRENCY attempts; a slot freed by a finished
 * attempt is filled at once with the next due delivery, so a slow receiver
 * holds one slot, not a whole batch. Returns how many were attempted.
 */
export async function deliverDueWebhooks({ concurrency = SEND_CONCURRENCY, max = 500 } = {}): Promise<number> {
  if (config.WEBHOOKS !== "on") return 0;
  const inFlight = new Set<Promise<void>>();
  let attempted = 0;
  let drained = false;
  for (;;) {
    if (!drained && attempted < max) {
      const claimed = await claimDue(Math.min(concurrency - inFlight.size, max - attempted));
      if (!claimed.length) drained = true;
      for (const delivery of claimed) {
        attempted++;
        const attempt = (async () => {
          const result = await send(
            { id: delivery.endpoint_id, url: delivery.url, secret_enc: delivery.secret_enc },
            delivery,
          );
          await record(delivery, result);
        })()
          .catch(() => log.error({ event: "webhooks.record_failed" }))
          .finally(() => inFlight.delete(attempt));
        inFlight.add(attempt);
      }
    }
    if (!inFlight.size) break;
    if (drained || inFlight.size >= concurrency || attempted >= max) {
      await Promise.race(inFlight);
      // A finished attempt may have made room for an address that was full.
      drained = false;
    }
  }
  return attempted;
}

/**
 * Housekeeping (hourly, whatever WEBHOOKS says): a delivery still waiting
 * after a week is given up — its shelf archived, its creator gone, webhooks
 * switched off for the installation — and finished ones leave the log after
 * 30 days.
 */
export async function expireWebhookDeliveries() {
  const expired = await db.query(
    `UPDATE webhook_deliveries SET state='failed',next_attempt_at=NULL,leased_until=NULL,last_error='expired'
     WHERE id IN (SELECT id FROM webhook_deliveries
                   WHERE state='pending' AND created_at<now()-$1*interval '1 day' LIMIT 5000)`,
    [PENDING_EXPIRE_DAYS],
  );
  const removed = await db.query(
    `DELETE FROM webhook_deliveries WHERE id IN (
       SELECT id FROM webhook_deliveries
        WHERE state<>'pending' AND created_at<now()-$1*interval '1 day' LIMIT 5000)`,
    [LOG_DAYS],
  );
  return { expired: expired.rowCount ?? 0, removed: removed.rowCount ?? 0 };
}

const loop = (name: string, pass: () => Promise<unknown>) => {
  let running = false;
  return async () => {
    if (running || config.WEBHOOKS !== "on") return;
    running = true;
    try {
      await pass();
    } catch {
      log.error({ event: `webhooks.${name}_failed` });
    } finally {
      running = false;
    }
  };
};
/** main.ts runs each on its own timer; a loop never overlaps itself. */
export const runWebhookDispatch = loop("dispatch", () => dispatchAllWebhookEvents());
export const runWebhookSend = loop("send", () => deliverDueWebhooks());
