import { db } from "./db.ts";
import { log } from "./log.ts";

/**
 * Counts one agent read of a shelf (list, one work, the events feed) for the
 * metric «share of machine reads». A count per shelf, UTC day and kind of
 * token; never which work or who. Best effort: a failure here must not fail
 * the read.
 *
 * Counts are added up in memory and written every FLUSH_MS in one statement:
 * an upsert per read on one row per shelf and day was a hot row and a third
 * of the database work of an agent's read. Each process adds its own counts,
 * so several processes still sum correctly. What a crashed process had not
 * written yet (at most FLUSH_MS of reads) is lost; a graceful shutdown calls
 * flushAgentReads. A batch the database refused (a brief outage) goes back
 * into memory and is written with the next one; at most PENDING_MAX counters
 * are held, so a long outage drops the counts past that, not the process.
 */
export const AGENT_READS_FLUSH_MS = 10_000;
export const AGENT_READS_PENDING_MAX = 10_000;
const pending = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let warned = false;

/** Adds `reads` to a counter; a new counter only while fewer than PENDING_MAX are held. */
function add(key: string, reads: number) {
  const held = pending.get(key);
  if (held !== undefined) pending.set(key, held + reads);
  else if (pending.size < AGENT_READS_PENDING_MAX) pending.set(key, reads);
}

export async function countAgentRead(tenantId: string, principal: "human" | "service" | undefined) {
  const day = new Date().toISOString().slice(0, 10);
  add(`${tenantId}|${principal ?? "human"}|${day}`, 1);
  schedule();
}

function schedule() {
  if (!timer && pending.size) {
    timer = setTimeout(() => {
      timer = null;
      void flushAgentReads();
    }, AGENT_READS_FLUSH_MS);
    // Counting never keeps a process alive.
    timer.unref();
  }
}

const transient = (error: any) => {
  const code = typeof error?.code === "string" ? error.code : "";
  return !/^[0-9A-Z]{5}$/.test(code) || /^(08|40|53|57)/.test(code);
};

/** The counters held in memory now (tests). */
export const pendingAgentReads = () => pending.size;

/** Writes the counts held in memory now (the timer, a graceful shutdown, tests). */
export async function flushAgentReads() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending.size) return;
  const rows = [...pending].map(([key, reads]) => [...key.split("|"), reads] as [string, string, string, number]);
  pending.clear();
  try {
    // A shelf that left meanwhile (an erased person's own shelf, 062) gets no new row.
    await db.query(
      `INSERT INTO agent_read_days(tenant_id,day,principal_type,reads)
       SELECT counts.tenant_id,counts.day,counts.principal_type,counts.reads
         FROM unnest($1::uuid[],$2::text[],$3::date[],$4::int[]) AS counts(tenant_id,principal_type,day,reads)
         JOIN tenants tenant ON tenant.id=counts.tenant_id AND tenant.state='active'
         LEFT JOIN accounts owner ON owner.id=tenant.owner_id
        WHERE tenant.owner_id IS NULL OR owner.deletion_requested_at IS NULL
       ON CONFLICT (tenant_id,day,principal_type) DO UPDATE SET reads=agent_read_days.reads+EXCLUDED.reads`,
      [rows.map((row) => row[0]), rows.map((row) => row[1]), rows.map((row) => row[2]), rows.map((row) => row[3])],
    );
  } catch (error: any) {
    const missing = error?.code === "42501" || error?.code === "42P01";
    // Not lost to a brief outage (no connection, a restart, a timeout, a
    // deadlock): back into memory, written with the next batch. A batch the
    // database itself rejects would be rejected again.
    if (transient(error)) {
      for (const [tenantId, principal, day, reads] of rows) add(`${tenantId}|${principal}|${day}`, reads);
      schedule();
    }
    // Counting is not worth a failed read, but a missing table or grant (an
    // operator who migrated without re-running the grants) must not stay silent.
    if (!warned && missing) {
      warned = true;
      log.warn({ event: "agent_read_counter_unavailable", code: error.code });
    }
  }
}
