// Blank the values in command templates stored before the server re-scrubbed
// them (agent_session_tool_calls.template, docs/specs/AGENT_SESSIONS.md):
// an older polka-sessions.mjs kept `mysql -u root -pS3cret` as it was. The
// same scrubTemplate the server applies to every incoming template. Run by
// scripts/sessions-scrub-templates.ts as the runtime role, which may UPDATE
// that table (deploy/runtime-grants.sql, migration 065).
//
// Idempotent: scrubTemplate of a clean template is the same template, and
// the update repeats the old value as its condition, so a concurrent upload
// or a second run changes nothing. Reports counts only, never a template.
import { db } from "./db.ts";
import { scrubTemplate } from "../../scripts/polka-sessions.mjs";

type Row = { session_id: string; seq: number; template: string };

export type TemplateScrubReport = {
  /** Tool calls with a template, read. */
  scanned: number;
  /** Of those, templates that still held a value. */
  dirty: number;
  /** Rewritten (0 on a dry run). */
  updated: number;
};

export async function scrubSessionTemplates(
  options: { dryRun?: boolean; batch?: number } = {},
): Promise<TemplateScrubReport> {
  const batch = options.batch ?? 1000;
  const report: TemplateScrubReport = { scanned: 0, dirty: 0, updated: 0 };
  // Keyset over the primary key: each row is read once, however many change.
  const page = async (after: Row | null): Promise<Row[]> =>
    (
      await db.query(
        `SELECT session_id,seq,template FROM agent_session_tool_calls
         WHERE template IS NOT NULL
           AND ($1::uuid IS NULL OR (session_id,seq)>($1::uuid,$2::integer))
         ORDER BY session_id,seq LIMIT $3`,
        [after?.session_id ?? null, after?.seq ?? 0, batch],
      )
    ).rows;
  let last: Row | null = null;
  for (;;) {
    const rows = await page(last);
    if (!rows.length) break;
    report.scanned += rows.length;
    last = rows[rows.length - 1]!;
    const changed = rows
      .map((row) => ({ ...row, clean: scrubTemplate(row.template) }))
      .filter((row) => row.clean !== row.template);
    report.dirty += changed.length;
    if (!changed.length || options.dryRun) continue;
    const result = await db.query(
      `UPDATE agent_session_tool_calls call SET template=fix.clean
       FROM unnest($1::uuid[],$2::integer[],$3::text[],$4::text[]) AS fix(session_id,seq,old,clean)
       WHERE call.session_id=fix.session_id AND call.seq=fix.seq AND call.template=fix.old`,
      [
        changed.map((row) => row.session_id),
        changed.map((row) => row.seq),
        changed.map((row) => row.template),
        changed.map((row) => row.clean),
      ],
    );
    report.updated += result.rowCount ?? 0;
  }
  return report;
}
