import { randomBytes, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { uuid } from "../../packages/contracts/index.ts";
import type { ExtensionContext, SessionSelection } from "../../packages/extension-api/index.ts";
import { audit } from "./artifacts.ts";
import { assertStrongSession, identity } from "./auth.ts";
import { config } from "./config.ts";
import { afterCommit, db, transaction } from "./db.ts";
import { Problem } from "./errors.ts";
import { checkSessionDelete, installationFingerprintKey } from "./extensions.ts";
import { bearerActor } from "./publish-api.ts";
import { withServiceActorTransaction, type ServiceActor } from "./service-auth.ts";
import { lockShelf } from "./shelves.ts";
import { deleteVersion, putImmutable, readBlob, sha256 } from "./storage.ts";

/**
 * Agent sessions (docs/specs/AGENT_SESSIONS.md): a person's Claude Code and
 * Codex sessions, sent by scripts/polka-sessions.mjs with secrets already
 * replaced on the machine. Not works: no versions, no review by a model, no
 * shelf search, no links in 0.11. The last upload of a session replaces it.
 */

export const SESSION_LIMITS = {
  /** The compressed index (POST /api/v1/sessions). */
  indexBytes: 8 * 1024 * 1024,
  /** …and decompressed. */
  indexJsonBytes: 96 * 1024 * 1024,
  transcriptBytes: 64 * 1024 * 1024,
  /** A transcript bigger than this unpacked is only downloaded, not shown. */
  transcriptViewBytes: 256 * 1024 * 1024,
  toolCalls: 20_000,
};

export const isSessionApiPath = (pathname: string) =>
  pathname === "/api/v1/sessions" ||
  pathname === "/api/v1/sessions/key" ||
  /^\/api\/v1\/sessions\/[0-9a-f-]{36}\/transcript$/i.test(pathname);

const text = (max: number) => z.string().max(max);
const nullableText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value ? value.slice(0, max) : null));
const count = z.number().int().min(0).max(1e15);
const timestamp = z.number().int().min(0).max(4102444800000).nullish();

const toolCallSchema = z.object({
  seq: z.number().int().min(0).max(10_000_000),
  at: timestamp,
  tool: z.string().min(1).transform((value) => value.slice(0, 200)),
  kind: z.enum(["shell", "edit", "read", "web", "mcp", "task", "other"]),
  mcpServer: nullableText(100),
  status: z.enum(["ok", "error", "interrupted", "unknown"]),
  durationMs: z.number().int().nullish(),
  exitCode: z.number().int().min(-2147483648).max(2147483647).nullish(),
  inputBytes: count,
  outputBytes: count,
  argv0: nullableText(100),
  template: nullableText(200),
  hosts: z.array(text(253)).max(20).default([]),
  network: z.boolean().default(false),
  subagent: z.boolean().default(false),
  pipeToShell: z.boolean().optional(),
});

const usageSchema = z.object({
  input: count.default(0),
  output: count.default(0),
  cacheRead: count.default(0),
  cacheWrite: count.default(0),
});

export const sessionBodySchema = z.object({
  schema: z.literal("polka-session-index/1"),
  source: z.enum(["claude-code", "codex"]),
  externalId: z.string().min(1).max(200),
  cliVersion: nullableText(50),
  project: z
    .object({ label: nullableText(200), remote: nullableText(500), gitBranch: nullableText(200) })
    .default({ label: null, remote: null, gitBranch: null }),
  permissionMode: nullableText(100),
  startedAt: timestamp,
  endedAt: timestamp,
  turns: count.default(0),
  prompts: count.default(0),
  toolCallCount: count.default(0),
  toolCalls: z.array(toolCallSchema).max(SESSION_LIMITS.toolCalls),
  tokens: usageSchema.extend({ reasoning: count.default(0) }).default({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
  models: z.record(z.string().max(100), usageSchema).refine((value) => Object.keys(value).length <= 50, "Too many models").default({}),
  costUSD: z.number().min(0).max(1e9).nullish(),
  links: z
    .object({
      works: z.array(uuid).max(100).default([]),
      prs: z.array(z.string().url().max(500).startsWith("https://")).max(100).default([]),
    })
    .default({ works: [], prs: [] }),
  secrets: z
    .array(
      z.object({
        fingerprint: z.string().regex(/^[0-9a-f]{12}$/),
        type: z.string().min(1).max(50),
        confidence: z.enum(["high", "medium", "low"]),
        prefix: nullableText(20),
        length: count,
        occurrences: count,
        seenByModel: z.boolean().default(false),
        modelEmitted: z.boolean().default(false),
        toCommand: z.boolean().default(false),
        toNetwork: z.boolean().default(false),
        writtenToFile: z.boolean().default(false),
      }),
    )
    .max(5000)
    .default([]),
  transcript: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(1).max(SESSION_LIMITS.transcriptBytes) }),
});
export type SessionBody = z.infer<typeof sessionBodySchema>;

/** What the server, not the machine, decides: the secrets status. */
export function secretsStatus(secrets: SessionBody["secrets"]) {
  if (secrets.some((s) => s.toNetwork)) return "sent_out";
  if (secrets.some((s) => s.toCommand || s.writtenToFile)) return "used";
  return secrets.length ? "seen" : "clean";
}

/** Rules v1: facts worth a look, from the index alone. */
const DESTRUCTIVE = [
  /^rm -(?:rf|fr|r -f|f -r)\b/,
  /^git push (?:--force|-f)\b/,
  /^git push --force-with-lease\b/,
  /^git reset --hard\b/,
  /^git clean -[a-z]*f/,
  /^terraform (?:destroy|apply -auto-approve)\b/,
  /^kubectl delete\b/,
  /^helm (?:uninstall|delete)\b/,
  /^dropdb\b/,
  /^docker (?:system prune|volume prune|rm -f)\b/,
  /^yc [a-z-]+ [a-z-]+ delete\b/,
];
export type SessionAlert = { rule: "secret_sent_out" | "destructive_command" | "pipe_to_shell" | "no_approvals"; count: number; firstSeq: number | null };
export function sessionAlerts(body: SessionBody): SessionAlert[] {
  const alerts: SessionAlert[] = [];
  const sent = body.secrets.filter((s) => s.toNetwork).length;
  if (sent) alerts.push({ rule: "secret_sent_out", count: sent, firstSeq: null });
  const destructive = body.toolCalls.filter((c) => c.kind === "shell" && c.template && DESTRUCTIVE.some((re) => re.test(c.template!)));
  if (destructive.length) alerts.push({ rule: "destructive_command", count: destructive.length, firstSeq: destructive[0]!.seq });
  const piped = body.toolCalls.filter((c) => c.pipeToShell);
  if (piped.length) alerts.push({ rule: "pipe_to_shell", count: piped.length, firstSeq: piped[0]!.seq });
  if (body.permissionMode && /^(?:bypassPermissions|never\/danger-full-access)$/.test(body.permissionMode))
    alerts.push({ rule: "no_approvals", count: 1, firstSeq: null });
  return alerts;
}

let prices: Array<[string, number[]]> | null = null;
/** USD per million tokens by model prefix (AGENT_MODEL_PRICES), longest prefix first. */
function modelPrices() {
  if (prices) return prices;
  try {
    const parsed = config.AGENT_MODEL_PRICES ? JSON.parse(config.AGENT_MODEL_PRICES) : {};
    prices = Object.entries(parsed)
      .filter((entry): entry is [string, number[]] => Array.isArray(entry[1]) && entry[1].length === 4 && entry[1].every((n) => typeof n === "number" && n >= 0))
      .sort((a, b) => b[0].length - a[0].length);
  } catch {
    prices = [];
  }
  return prices;
}
/** The agent's own figure, else an estimate when every model is priced, else null. */
export function sessionCost(body: SessionBody): { cost: number | null; estimated: boolean } {
  // Claude Code writes 0 when it does not know the price (a subscription):
  // that is no figure, not a free session.
  const worked = body.tokens.input + body.tokens.output > 0;
  if (typeof body.costUSD === "number" && (body.costUSD > 0 || !worked)) return { cost: body.costUSD, estimated: false };
  const used = Object.entries(body.models).filter(([, u]) => u.input + u.output + u.cacheRead + u.cacheWrite > 0);
  if (!used.length) return { cost: null, estimated: false };
  let total = 0;
  for (const [model, usage] of used) {
    const price = modelPrices().find(([prefix]) => model.startsWith(prefix))?.[1];
    if (!price) return { cost: null, estimated: false };
    total += (usage.input * price[0]! + usage.output * price[1]! + usage.cacheRead * price[2]! + usage.cacheWrite * price[3]!) / 1e6;
  }
  return { cost: Math.round(total * 1e6) / 1e6, estimated: true };
}

const disabled = () =>
  new Problem(403, "forbidden", "Сессии агентов на этой полке не включены. Их включает оператор установки.", { reason: "sessions_disabled" });
const overQuota = () =>
  new Problem(413, "quota", "Место для сессий агентов закончилось. Удалите старые сессии на странице «Сессии».");

/** The shelf row, locked by the caller's transaction; sessions live on personal shelves only. */
async function sessionShelf(c: PoolClient, tenantId: string, accountId: string) {
  const {
    rows: [tenant],
  } = await c.query(
    `SELECT kind, owner_id, session_quota_bytes, session_used_bytes FROM tenants WHERE id=$1 AND state='active' FOR UPDATE`,
    [tenantId],
  );
  if (!tenant || tenant.kind !== "personal" || tenant.owner_id !== accountId)
    throw new Problem(403, "forbidden", "Сессии агентов хранятся только на личной полке. Выдайте токен на своей полке.");
  const quota = Math.max(Number(tenant.session_quota_bytes), config.AGENT_SESSION_QUOTA_BYTES);
  return { quota, used: Number(tenant.session_used_bytes) };
}

/** Whether sessions are on for a person's own shelf, and its allowance. */
export async function sessionAllowance(tenantId: string) {
  const {
    rows: [tenant],
  } = await db.query(`SELECT kind, session_quota_bytes, session_used_bytes FROM tenants WHERE id=$1`, [tenantId]);
  const quota = tenant?.kind === "personal" ? Math.max(Number(tenant.session_quota_bytes), config.AGENT_SESSION_QUOTA_BYTES) : 0;
  return { enabled: quota > 0, quotaBytes: quota, usedBytes: Number(tenant?.session_used_bytes ?? 0), notice: sessionNotice() };
}

const agentActor = (actor: ServiceActor) => ({ id: actor.accountId, tenant: actor.tenantId, connectionId: actor.connectionId });

/** The installation's notice for people sending sessions, or null. */
const sessionNotice = () => config.AGENT_SESSION_NOTICE.trim() || null;

/**
 * The HMAC key for secret fingerprints: one per shelf, made on first use; or,
 * with AGENT_SESSION_FINGERPRINTS=installation, one for everybody, derived
 * from LINK_KEY one way (the machines get the key, never LINK_KEY).
 */
export async function fingerprintKey(actor: ServiceActor) {
  return withServiceActorTransaction(actor, "sessions", async (c, verified) => {
    const shelf = await sessionShelf(c, verified.tenantId, verified.accountId);
    if (!shelf.quota) throw disabled();
    const notice = sessionNotice();
    if (config.AGENT_SESSION_FINGERPRINTS === "installation")
      return { key: installationFingerprintKey(), scope: "installation", notice };
    const {
      rows: [row],
    } = await c.query(
      `UPDATE tenants SET session_fingerprint_key=COALESCE(session_fingerprint_key,$2) WHERE id=$1 RETURNING session_fingerprint_key`,
      [verified.tenantId, randomBytes(32)],
    );
    return { key: Buffer.from(row.session_fingerprint_key).toString("hex"), scope: "shelf", notice };
  });
}

const transcriptKey = (tenantId: string, sessionId: string, hash: string) => `${tenantId}/sessions/${sessionId}/${hash}.jsonl.gz`;

/** POST /api/v1/sessions: the index, gzipped. Replaces an earlier upload of the same session. */
export async function saveSession(actor: ServiceActor, gz: Buffer) {
  if (gz.length > SESSION_LIMITS.indexBytes) throw overQuota();
  let body: SessionBody;
  try {
    const json = gunzipSync(gz, { maxOutputLength: SESSION_LIMITS.indexJsonBytes });
    body = sessionBodySchema.parse(JSON.parse(json.toString("utf8")));
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Problem(400, "invalid", `Проверьте поля сессии: ${[...new Set(error.issues.map((i) => i.path.slice(0, 2).join(".") || "body"))].slice(0, 5).join(", ")}.`);
    throw new Problem(400, "invalid", "Тело запроса — сжатый gzip JSON индекса сессии (polka-session-index/1).");
  }
  const status = secretsStatus(body.secrets);
  const alerts = sessionAlerts(body);
  const { cost, estimated } = sessionCost(body);
  return withServiceActorTransaction(actor, "sessions", async (c, verified) => {
    const shelf = await sessionShelf(c, verified.tenantId, verified.accountId);
    if (!shelf.quota) throw disabled();
    const {
      rows: [existing],
    } = await c.query(
      `SELECT id, account_id, transcript_key, transcript_bytes, index_bytes FROM agent_sessions
        WHERE tenant_id=$1 AND source=$2 AND external_id=$3 FOR UPDATE`,
      [verified.tenantId, body.source, body.externalId],
    );
    const id: string = existing?.id ?? randomUUID();
    const delta = gz.length - Number(existing?.index_bytes ?? 0);
    if (shelf.used + delta > shelf.quota) throw overQuota();
    await c.query(
      `INSERT INTO agent_sessions(id, tenant_id, account_id, connection_id, source, external_id, project_label, project_remote,
         git_branch, cli_version, permission_mode, started_at, ended_at, turns, prompts, tool_call_count, tokens, models,
         cost_usd, cost_estimated, secrets_status, alerts, index_bytes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12::float8/1000),to_timestamp($13::float8/1000),$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (tenant_id, source, external_id) DO UPDATE SET
         connection_id=EXCLUDED.connection_id, project_label=EXCLUDED.project_label, project_remote=EXCLUDED.project_remote,
         git_branch=EXCLUDED.git_branch, cli_version=EXCLUDED.cli_version, permission_mode=EXCLUDED.permission_mode,
         started_at=EXCLUDED.started_at, ended_at=EXCLUDED.ended_at, turns=EXCLUDED.turns, prompts=EXCLUDED.prompts,
         tool_call_count=EXCLUDED.tool_call_count, tokens=EXCLUDED.tokens, models=EXCLUDED.models, cost_usd=EXCLUDED.cost_usd,
         cost_estimated=EXCLUDED.cost_estimated, secrets_status=EXCLUDED.secrets_status, alerts=EXCLUDED.alerts,
         index_bytes=EXCLUDED.index_bytes, updated_at=now()`,
      [
        id, verified.tenantId, verified.accountId, verified.connectionId, body.source, body.externalId,
        body.project.label, body.project.remote, body.project.gitBranch, body.cliVersion, body.permissionMode,
        body.startedAt ?? null, body.endedAt ?? null, body.turns, body.prompts, Math.max(body.toolCallCount, body.toolCalls.length),
        JSON.stringify(body.tokens), JSON.stringify(body.models), cost, estimated, status, JSON.stringify(alerts), gz.length,
      ],
    );
    await c.query(`DELETE FROM agent_session_tool_calls WHERE session_id=$1`, [id]);
    await c.query(`DELETE FROM agent_session_secrets WHERE session_id=$1`, [id]);
    await c.query(`DELETE FROM agent_session_links WHERE session_id=$1`, [id]);
    const calls = body.toolCalls;
    if (calls.length)
      await c.query(
        `INSERT INTO agent_session_tool_calls(session_id, seq, at, tool, kind, mcp_server, status, duration_ms, exit_code,
           input_bytes, output_bytes, argv0, template, hosts, network, subagent)
         SELECT $1, call.seq, to_timestamp(call.at::float8/1000), call.tool, call.kind, call.mcp_server, call.status, call.duration_ms,
           call.exit_code, call.input_bytes, call.output_bytes, call.argv0, call.template,
           ARRAY(SELECT jsonb_array_elements_text(call.hosts)), call.network, call.subagent
           FROM jsonb_to_recordset($2::jsonb) AS call(seq int, at bigint, tool text, kind text, mcp_server text, status text,
             duration_ms bigint, exit_code int, input_bytes bigint, output_bytes bigint, argv0 text, template text,
             hosts jsonb, network boolean, subagent boolean)
         ON CONFLICT DO NOTHING`,
        [
          id,
          JSON.stringify(
            calls.map((call) => ({
              seq: call.seq, at: call.at ?? null, tool: call.tool, kind: call.kind, mcp_server: call.mcpServer, status: call.status,
              duration_ms: call.durationMs ?? null, exit_code: call.exitCode ?? null, input_bytes: call.inputBytes, output_bytes: call.outputBytes,
              argv0: call.argv0, template: call.template, hosts: call.hosts, network: call.network, subagent: call.subagent,
            })),
          ),
        ],
      );
    if (body.secrets.length)
      await c.query(
        `INSERT INTO agent_session_secrets(session_id, fingerprint, type, confidence, prefix, length, occurrences,
           seen_by_model, model_emitted, to_command, to_network, written_to_file)
         SELECT $1, s.fingerprint, s.type, s.confidence, s.prefix, s.length, s.occurrences, s.seen_by_model, s.model_emitted,
           s.to_command, s.to_network, s.written_to_file
           FROM jsonb_to_recordset($2::jsonb) AS s(fingerprint text, type text, confidence text, prefix text, length int,
             occurrences int, seen_by_model boolean, model_emitted boolean, to_command boolean, to_network boolean, written_to_file boolean)
         ON CONFLICT DO NOTHING`,
        [
          id,
          JSON.stringify(
            body.secrets.map((s) => ({
              fingerprint: s.fingerprint, type: s.type, confidence: s.confidence, prefix: s.prefix, length: s.length, occurrences: s.occurrences,
              seen_by_model: s.seenByModel, model_emitted: s.modelEmitted, to_command: s.toCommand, to_network: s.toNetwork, written_to_file: s.writtenToFile,
            })),
          ),
        ],
      );
    // Works only of this shelf; other ids in the transcript are dropped.
    if (body.links.works.length)
      await c.query(
        `INSERT INTO agent_session_links(session_id, kind, target, artifact_id)
         SELECT $1, 'work', a.id::text, a.id FROM artifacts a WHERE a.tenant_id=$2 AND a.id = ANY($3::uuid[])
         ON CONFLICT DO NOTHING`,
        [id, verified.tenantId, body.links.works],
      );
    if (body.links.prs.length)
      await c.query(
        `INSERT INTO agent_session_links(session_id, kind, target) SELECT $1, 'pr', pr FROM unnest($2::text[]) pr ON CONFLICT DO NOTHING`,
        [id, body.links.prs],
      );
    await c.query(`UPDATE tenants SET session_used_bytes=session_used_bytes+$2 WHERE id=$1`, [verified.tenantId, delta]);
    // Ids and counts only, never content.
    await audit(c, agentActor(verified), "session.saved", id, { source: body.source, toolCalls: body.toolCalls.length, secrets: status });
    return {
      id,
      created: !existing,
      transcriptNeeded: existing?.transcript_key !== transcriptKey(verified.tenantId, id, body.transcript.sha256),
      secretsStatus: status,
      alerts: alerts.map((alert) => alert.rule),
      url: `${config.APP_ORIGIN}/sessions/${id}`,
    };
  });
}

/** PUT /api/v1/sessions/:id/transcript: the redacted transcript, gzipped JSON lines. */
export async function saveTranscript(actor: ServiceActor, sessionId: string, gz: Buffer) {
  if (gz.length < 20 || gz[0] !== 0x1f || gz[1] !== 0x8b)
    throw new Problem(400, "invalid", "Расшифровка — файл gzip (polka-session-transcript/1).");
  if (gz.length > SESSION_LIMITS.transcriptBytes) throw overQuota();
  const hash = sha256(gz);
  const key = transcriptKey(actor.tenantId, sessionId, hash);
  // Written before the transaction: a stored object holds no lock (artifacts.ts does the same).
  const version = await putImmutable(key, gz);
  let kept = false;
  try {
    const result = await withServiceActorTransaction(actor, "sessions", async (c, verified) => {
      const shelf = await sessionShelf(c, verified.tenantId, verified.accountId);
      if (!shelf.quota) throw disabled();
      const {
        rows: [session],
      } = await c.query(
        `SELECT transcript_key, transcript_version, transcript_bytes FROM agent_sessions
          WHERE id=$1 AND tenant_id=$2 AND account_id=$3 FOR UPDATE`,
        [sessionId, verified.tenantId, verified.accountId],
      );
      if (!session) throw new Problem(404, "not_found", "Сессия не найдена: сначала отправьте её индекс.");
      if (session.transcript_key === key) {
        kept = true;
        return { id: sessionId, bytes: gz.length };
      }
      const delta = gz.length - Number(session.transcript_bytes);
      if (shelf.used + delta > shelf.quota) throw overQuota();
      await c.query(
        `UPDATE agent_sessions SET transcript_key=$2, transcript_version=$3, transcript_bytes=$4, updated_at=now() WHERE id=$1`,
        [sessionId, key, version, gz.length],
      );
      await c.query(`UPDATE tenants SET session_used_bytes=session_used_bytes+$2 WHERE id=$1`, [verified.tenantId, delta]);
      kept = true;
      if (session.transcript_key && session.transcript_version)
        afterCommit(c, () => deleteVersion(session.transcript_key, session.transcript_version));
      return { id: sessionId, bytes: gz.length };
    });
    return result;
  } finally {
    if (!kept) await deleteVersion(key, version).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The owner's pages

type Person = { id: string; tenant: string };

/**
 * Whose sessions a read covers: a person's own (their shelf, themselves), or
 * for an extension the whole installation, optionally some people only.
 */
export type SessionScope = { tenant: string; accounts: string[] } | { tenant: null; accounts: string[] | null };
const own = (person: Person): SessionScope => ({ tenant: person.tenant, accounts: [person.id] });
/** Takes $1 and $2 of every query below. */
const IN_SCOPE = `($1::uuid IS NULL OR s.tenant_id=$1) AND ($2::uuid[] IS NULL OR s.account_id=ANY($2::uuid[]))`;
const scopeParams = (scope: SessionScope) => [scope.tenant, scope.accounts];

const SESSION_COLUMNS = `s.id, s.account_id AS "accountId", s.source, s.external_id AS "externalId", s.project_label AS "projectLabel", s.project_remote AS "projectRemote",
  s.git_branch AS "gitBranch", s.cli_version AS "cliVersion", s.permission_mode AS "permissionMode", s.started_at AS "startedAt",
  s.ended_at AS "endedAt", s.turns, s.prompts, s.tool_call_count AS "toolCallCount", s.tokens, s.models,
  s.cost_usd::float8 AS "costUSD", s.cost_estimated AS "costEstimated", s.secrets_status AS "secretsStatus", s.alerts,
  s.transcript_bytes AS "transcriptBytes", s.uploaded_at AS "uploadedAt", s.updated_at AS "updatedAt"`;

const listQuery = z.object({
  source: z.enum(["claude-code", "codex"]).optional(),
  project: z.string().max(200).optional(),
  secrets: z.enum(["clean", "seen", "used", "sent_out", "any"]).optional(),
  alerts: z.enum(["any"]).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listSessions(person: Person, query: unknown) {
  return { ...(await sessionAllowance(person.tenant)), ...(await listSessionsIn(own(person), query)) };
}

export async function listSessionsIn(scope: SessionScope, query: unknown) {
  const q = listQuery.parse(query ?? {});
  const { rows } = await db.query(
    `SELECT ${SESSION_COLUMNS} FROM agent_sessions s
      WHERE ${IN_SCOPE}
        AND ($3::text IS NULL OR s.source=$3) AND ($4::text IS NULL OR s.project_label=$4)
        AND ($5::text IS NULL OR ($5='any' AND s.secrets_status<>'clean') OR s.secrets_status=$5)
        AND ($6::text IS NULL OR jsonb_array_length(s.alerts) > 0)
        AND ($7::timestamptz IS NULL OR COALESCE(s.started_at, s.uploaded_at) < $7)
      ORDER BY COALESCE(s.started_at, s.uploaded_at) DESC, s.id LIMIT $8`,
    [...scopeParams(scope), q.source ?? null, q.project ?? null, q.secrets ?? null, q.alerts ?? null, q.before ?? null, q.limit + 1],
  );
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const { rows: projects } = await db.query(
    `SELECT s.project_label AS label, count(*)::int AS sessions FROM agent_sessions s WHERE ${IN_SCOPE} AND s.project_label IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 50`,
    scopeParams(scope),
  );
  return {
    sessions: page,
    projects,
    next: rows.length > q.limit && last ? new Date(last.startedAt ?? last.uploadedAt).toISOString() : null,
  };
}

async function sessionIn(scope: SessionScope, sessionId: string) {
  const {
    rows: [session],
  } = await db.query(`SELECT ${SESSION_COLUMNS}, s.tenant_id, s.transcript_key, s.transcript_version FROM agent_sessions s WHERE ${IN_SCOPE} AND s.id=$3`, [
    ...scopeParams(scope),
    sessionId,
  ]);
  if (!session) throw new Problem(404, "not_found", "Сессия не найдена.");
  return session;
}

export const getSession = (person: Person, sessionId: string) => getSessionIn(own(person), sessionId);

export async function getSessionIn(scope: SessionScope, sessionId: string) {
  const { tenant_id: tenantId, transcript_key: _key, transcript_version: _version, ...session } = await sessionIn(scope, sessionId);
  const [calls, secrets, links] = await Promise.all([
    db.query(
      `SELECT seq, at, tool, kind, mcp_server AS "mcpServer", status, duration_ms::float8 AS "durationMs", exit_code AS "exitCode",
         input_bytes::float8 AS "inputBytes", output_bytes::float8 AS "outputBytes", argv0, template, hosts, network, subagent
         FROM agent_session_tool_calls WHERE session_id=$1 ORDER BY seq`,
      [sessionId],
    ),
    db.query(
      `SELECT fingerprint, type, confidence, prefix, length, occurrences, seen_by_model AS "seenByModel", model_emitted AS "modelEmitted",
         to_command AS "toCommand", to_network AS "toNetwork", written_to_file AS "writtenToFile",
         (SELECT count(DISTINCT other.session_id)::int FROM agent_session_secrets other JOIN agent_sessions o ON o.id=other.session_id
           WHERE other.fingerprint=s.fingerprint AND ($2::uuid IS NULL OR o.tenant_id=$2)) AS "sessions"
         FROM agent_session_secrets s WHERE session_id=$1 ORDER BY to_network DESC, to_command DESC, type`,
      [sessionId, scope.tenant],
    ),
    db.query(
      `SELECT l.kind, l.target, l.artifact_id AS "artifactId", a.title FROM agent_session_links l
         LEFT JOIN artifacts a ON a.id=l.artifact_id AND a.tenant_id=$2 AND a.trashed_at IS NULL WHERE l.session_id=$1 ORDER BY l.kind, l.target`,
      [sessionId, tenantId],
    ),
  ]);
  return { session, toolCalls: calls.rows, secrets: secrets.rows, links: links.rows };
}

const transcriptQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** A page of the transcript's events (the first line is its header). */
export const readTranscript = (person: Person, sessionId: string, query: unknown) => readTranscriptIn(own(person), sessionId, query);

export async function readTranscriptIn(scope: SessionScope, sessionId: string, query: unknown) {
  const q = transcriptQuery.parse(query ?? {});
  const session = await sessionIn(scope, sessionId);
  if (!session.transcript_key) return { events: [], total: 0, offset: q.offset, tooLarge: false };
  const gz = await readBlob(session.transcript_key, session.transcript_version);
  let lines: string[];
  try {
    lines = gunzipSync(gz, { maxOutputLength: SESSION_LIMITS.transcriptViewBytes }).toString("utf8").split("\n").filter(Boolean);
  } catch {
    return { events: [], total: 0, offset: q.offset, tooLarge: true };
  }
  const events = lines.slice(1 + q.offset, 1 + q.offset + q.limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { type: "unreadable" };
    }
  });
  return { events, total: lines.length - 1, offset: q.offset, tooLarge: false };
}

export const transcriptFile = (person: Person, sessionId: string) => transcriptFileIn(own(person), sessionId);

export async function transcriptFileIn(scope: SessionScope, sessionId: string) {
  const session = await sessionIn(scope, sessionId);
  if (!session.transcript_key) throw new Problem(404, "not_found", "Расшифровка ещё не загружена.");
  return { bytes: await readBlob(session.transcript_key, session.transcript_version), name: `${session.source}-${session.externalId}.jsonl.gz` };
}

export async function deleteSession(person: Person, sessionId: string) {
  return transaction(async (c) => {
    await lockShelf(c, person, "owner");
    const {
      rows: [found],
    } = await c.query(`SELECT source, started_at FROM agent_sessions WHERE id=$1 AND tenant_id=$2 AND account_id=$3 FOR UPDATE`, [
      sessionId,
      person.tenant,
      person.id,
    ]);
    if (!found) throw new Problem(404, "not_found", "Сессия не найдена.");
    await checkSessionDelete(
      { actor: { id: person.id, tenant: person.tenant }, sessionId, source: found.source, startedAt: found.started_at?.toISOString() ?? null },
      c,
    );
    const {
      rows: [session],
    } = await c.query(
      `DELETE FROM agent_sessions WHERE id=$1 RETURNING transcript_key, transcript_version, transcript_bytes + index_bytes AS bytes`,
      [sessionId],
    );
    await c.query(`UPDATE tenants SET session_used_bytes=GREATEST(0, session_used_bytes-$2) WHERE id=$1`, [person.tenant, session.bytes]);
    await audit(c, person, "session.deleted", sessionId);
    if (session.transcript_key && session.transcript_version)
      afterCommit(c, () => deleteVersion(session.transcript_key, session.transcript_version));
    return { deleted: true };
  });
}

const statsQuery = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) });

/** «Секреты» and «Расход»: the person's sessions over the last days. */
export const sessionStats = (person: Person, query: unknown) => sessionStatsIn(own(person), query);

export async function sessionStatsIn(where: SessionScope, query: unknown) {
  const { days } = statsQuery.parse(query ?? {});
  const params = [...scopeParams(where), days];
  const scope = `${IN_SCOPE} AND COALESCE(s.started_at, s.uploaded_at) > now() - make_interval(days => $3)`;
  const [byDay, byModel, secrets, fingerprints, hosts, mcp, alerts, totals, people] = await Promise.all([
    db.query(
      `SELECT to_char(date_trunc('day', COALESCE(s.started_at, s.uploaded_at)), 'YYYY-MM-DD') AS day, count(*)::int AS sessions,
         sum(s.tool_call_count)::float8 AS "toolCalls", sum((s.tokens->>'input')::float8) AS input, sum((s.tokens->>'output')::float8) AS output,
         sum((s.tokens->>'cacheRead')::float8) AS "cacheRead", sum(s.cost_usd)::float8 AS cost
         FROM agent_sessions s WHERE ${scope} GROUP BY 1 ORDER BY 1`,
      params,
    ),
    db.query(
      `SELECT m.key AS model, count(*)::int AS sessions, sum((m.value->>'input')::float8) AS input, sum((m.value->>'output')::float8) AS output,
         sum((m.value->>'cacheRead')::float8) AS "cacheRead", sum((m.value->>'cacheWrite')::float8) AS "cacheWrite"
         FROM agent_sessions s, jsonb_each(s.models) m WHERE ${scope} AND m.key <> '<synthetic>' GROUP BY 1 ORDER BY output DESC`,
      params,
    ),
    db.query(`SELECT s.secrets_status AS status, count(*)::int AS sessions FROM agent_sessions s WHERE ${scope} GROUP BY 1`, params),
    db.query(
      `SELECT x.fingerprint, min(x.type) AS type, min(x.prefix) AS prefix, count(DISTINCT x.session_id)::int AS sessions,
         sum(x.occurrences)::int AS occurrences, count(DISTINCT s.account_id)::int AS people, bool_or(x.to_network) AS "toNetwork", bool_or(x.to_command) AS "toCommand",
         bool_or(x.written_to_file) AS "writtenToFile", bool_or(x.seen_by_model) AS "seenByModel",
         max(COALESCE(s.started_at, s.uploaded_at)) AS "lastSeen", (array_agg(s.id ORDER BY COALESCE(s.started_at, s.uploaded_at) DESC))[1] AS "lastSessionId"
         FROM agent_session_secrets x JOIN agent_sessions s ON s.id=x.session_id WHERE ${scope}
         GROUP BY x.fingerprint ORDER BY bool_or(x.to_network) DESC, bool_or(x.to_command OR x.written_to_file) DESC, count(DISTINCT x.session_id) DESC LIMIT 200`,
      params,
    ),
    db.query(
      `SELECT h AS host, count(*)::int AS calls, count(DISTINCT c.session_id)::int AS sessions, count(DISTINCT s.account_id)::int AS people
         FROM agent_session_tool_calls c JOIN agent_sessions s ON s.id=c.session_id, unnest(c.hosts) h
        WHERE ${scope} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
      params,
    ),
    db.query(
      `SELECT c.mcp_server AS server, count(*)::int AS calls, count(*) FILTER (WHERE c.status='error')::int AS errors,
         count(DISTINCT s.account_id)::int AS people
         FROM agent_session_tool_calls c JOIN agent_sessions s ON s.id=c.session_id
        WHERE ${scope} AND c.mcp_server IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
      params,
    ),
    db.query(
      `SELECT a->>'rule' AS rule, count(*)::int AS sessions, sum((a->>'count')::int)::int AS count
         FROM agent_sessions s, jsonb_array_elements(s.alerts) a WHERE ${scope} GROUP BY 1 ORDER BY 2 DESC`,
      params,
    ),
    db.query(
      `SELECT count(*)::int AS sessions, COALESCE(sum(s.tool_call_count), 0)::float8 AS "toolCalls",
         COALESCE(sum(s.cost_usd), 0)::float8 AS cost, count(*) FILTER (WHERE s.cost_usd IS NULL)::int AS "withoutCost",
         bool_or(s.cost_estimated) AS "someEstimated"
         FROM agent_sessions s WHERE ${scope}`,
      params,
    ),
    // By person: only for a read across people.
    where.tenant
      ? Promise.resolve({ rows: [] })
      : db.query(
          `SELECT s.account_id AS "accountId", count(*)::int AS sessions, COALESCE(sum(s.tool_call_count), 0)::float8 AS "toolCalls",
             COALESCE(sum(s.cost_usd), 0)::float8 AS cost, count(*) FILTER (WHERE s.secrets_status='sent_out')::int AS "secretsSentOut",
             count(*) FILTER (WHERE jsonb_array_length(s.alerts) > 0)::int AS "withAlerts",
             max(COALESCE(s.started_at, s.uploaded_at)) AS "lastSession"
             FROM agent_sessions s WHERE ${scope} GROUP BY 1 ORDER BY 2 DESC`,
          params,
        ),
  ]);
  return {
    days,
    totals: totals.rows[0],
    byDay: byDay.rows,
    byModel: byModel.rows,
    secrets: Object.fromEntries(secrets.rows.map((row) => [row.status, row.sessions])),
    fingerprints: fingerprints.rows,
    hosts: hosts.rows,
    mcp: mcp.rows,
    alerts: alerts.rows,
    ...(where.tenant ? {} : { people: people.rows }),
  };
}

/** «Сделано в сессии» on a work's page. */
export async function sessionsOfWork(person: Person, artifactId: string) {
  const { rows } = await db.query(
    `SELECT s.id, s.source, s.project_label AS "projectLabel", s.started_at AS "startedAt", s.secrets_status AS "secretsStatus"
       FROM agent_session_links l JOIN agent_sessions s ON s.id=l.session_id
      WHERE l.artifact_id=$1 AND s.tenant_id=$2 AND s.account_id=$3 ORDER BY s.started_at DESC NULLS LAST LIMIT 20`,
    [artifactId, person.tenant, person.id],
  );
  return { sessions: rows };
}

/** For agents (MCP polka_sessions): recent sessions, compact. */
export async function sessionsForAgent(actor: ServiceActor, input: { days?: number; project?: string; secrets?: string; limit?: number }) {
  return withServiceActorTransaction(actor, "sessions", async (c, verified) => {
    await sessionShelf(c, verified.tenantId, verified.accountId);
    const { rows } = await c.query(
      `SELECT ${SESSION_COLUMNS} FROM agent_sessions s
        WHERE s.tenant_id=$1 AND s.account_id=$2 AND COALESCE(s.started_at, s.uploaded_at) > now() - make_interval(days => $3)
          AND ($4::text IS NULL OR s.project_label=$4) AND ($5::text IS NULL OR ($5='any' AND s.secrets_status<>'clean') OR s.secrets_status=$5)
        ORDER BY COALESCE(s.started_at, s.uploaded_at) DESC LIMIT $6`,
      [verified.tenantId, verified.accountId, input.days ?? 7, input.project ?? null, input.secrets ?? null, input.limit ?? 20],
    );
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      project: row.projectLabel,
      branch: row.gitBranch,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      prompts: row.prompts,
      toolCalls: row.toolCallCount,
      tokens: row.tokens,
      costUSD: row.costUSD,
      costEstimated: row.costEstimated,
      secrets: row.secretsStatus,
      alerts: (row.alerts as SessionAlert[]).map((alert) => alert.rule),
      url: `${config.APP_ORIGIN}/sessions/${row.id}`,
    }));
  });
}

export async function sessionStatsForAgent(actor: ServiceActor, days: number) {
  const person = await withServiceActorTransaction(actor, "sessions", async (c, verified) => {
    await sessionShelf(c, verified.tenantId, verified.accountId);
    return { id: verified.accountId, tenant: verified.tenantId };
  });
  const stats = await sessionStats(person, { days });
  return { ...stats, fingerprints: stats.fingerprints.slice(0, 20) };
}

const sessionId = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);

export function registerAgentSessions(app: FastifyInstance) {
  // Machines (polka-sessions.mjs): bearer only.
  app.get("/api/v1/sessions/key", async (req, reply) => fingerprintKey(await bearerActor(req, reply, "sessions")));
  app.post("/api/v1/sessions", { bodyLimit: SESSION_LIMITS.indexBytes }, async (req, reply) => {
    const actor = await bearerActor(req, reply, "sessions");
    if (!Buffer.isBuffer(req.body)) throw new Problem(415, "unsupported", "Отправьте индекс как application/octet-stream (gzip JSON).");
    return saveSession(actor, req.body);
  });
  app.put("/api/v1/sessions/:id/transcript", { bodyLimit: SESSION_LIMITS.transcriptBytes }, async (req, reply) => {
    const actor = await bearerActor(req, reply, "sessions");
    if (!Buffer.isBuffer(req.body)) throw new Problem(415, "unsupported", "Отправьте расшифровку как application/octet-stream (gzip).");
    return saveTranscript(actor, sessionId(req), req.body);
  });
  // The person's own pages: always the account's own shelf.
  app.get("/api/sessions", async (req) => listSessions(await identity(req), req.query));
  app.get("/api/sessions/stats", async (req) => sessionStats(await identity(req), req.query));
  app.get("/api/sessions/:id", async (req) => getSession(await identity(req), sessionId(req)));
  app.get("/api/sessions/:id/transcript", async (req) => readTranscript(await identity(req), sessionId(req), req.query));
  app.get("/api/sessions/:id/transcript.gz", async (req, reply) => {
    const file = await transcriptFile(await identity(req), sessionId(req));
    return reply
      .type("application/gzip")
      .header("content-disposition", `attachment; filename="${file.name.replace(/[^\w.-]/g, "_")}"`)
      .send(file.bytes);
  });
  app.delete("/api/sessions/:id", async (req) => {
    const actor = await identity(req);
    assertStrongSession(actor);
    return deleteSession(actor, sessionId(req));
  });
  app.get("/api/artifacts/:id/sessions", async (req) => sessionsOfWork(await identity(req), sessionId(req)));
}

const across = (selection: SessionSelection = {}): SessionScope => ({ tenant: null, accounts: selection.accounts ?? null });
const knownId = (value: string) => {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new Problem(404, "not_found", "Сессия не найдена.");
  return parsed.data;
};

/** context.sessions of extensions (packages/extension-api): the reads above, across people. */
export const sessionsForExtension: ExtensionContext["sessions"] = {
  list: async (selection, query) => (await listSessionsIn(across(selection), query)) as Awaited<ReturnType<ExtensionContext["sessions"]["list"]>>,
  get: async (sessionId, selection) => (await getSessionIn(across(selection), knownId(sessionId))) as Awaited<ReturnType<ExtensionContext["sessions"]["get"]>>,
  stats: async (selection, query) => sessionStatsIn(across(selection), query),
  transcript: async (sessionId, query) => readTranscriptIn(across(), knownId(sessionId), query),
  transcriptFile: async (sessionId) => transcriptFileIn(across(), knownId(sessionId)),
};
