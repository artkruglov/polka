import { db } from "./db.ts";

/**
 * Counts one agent read of a shelf (list, one work, the events feed) for the
 * metric «share of machine reads». A count per shelf, UTC day and kind of
 * token; never which work or who. Best effort: a failure here must not fail
 * the read.
 */
export async function countAgentRead(tenantId: string, principal: "human" | "service" | undefined) {
  try {
    await db.query(
      `INSERT INTO agent_read_days(tenant_id,day,principal_type,reads)
       VALUES($1,(now() AT TIME ZONE 'UTC')::date,$2,1)
       ON CONFLICT (tenant_id,day,principal_type) DO UPDATE SET reads=agent_read_days.reads+1`,
      [tenantId, principal ?? "human"],
    );
  } catch {
    // counting is not worth a failed read
  }
}
