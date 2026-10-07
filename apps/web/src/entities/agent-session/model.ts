import { request } from "../../shared/api/client.ts";

// A person's agent sessions (docs/specs/AGENT_SESSIONS.md): shapes of
// apps/server/agent-sessions.ts, Russian labels and formatting.

export type SessionSource = "claude-code" | "codex";
export type SecretsStatus = "clean" | "seen" | "used" | "sent_out";
export type AlertRule = "secret_sent_out" | "destructive_command" | "pipe_to_shell" | "no_approvals";
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number };

export type AgentSession = {
  id: string;
  source: SessionSource;
  externalId: string;
  projectLabel: string | null;
  projectRemote: string | null;
  gitBranch: string | null;
  cliVersion: string | null;
  permissionMode: string | null;
  startedAt: string | null;
  endedAt: string | null;
  turns: number;
  prompts: number;
  toolCallCount: number;
  tokens: Usage;
  models: Record<string, Usage>;
  costUSD: number | null;
  costEstimated: boolean;
  secretsStatus: SecretsStatus;
  alerts: { rule: AlertRule; count: number; firstSeq: number | null }[];
  transcriptBytes: number;
  uploadedAt: string;
  updatedAt: string;
};

export type ToolCall = {
  seq: number;
  at: string | null;
  tool: string;
  kind: "shell" | "edit" | "read" | "web" | "mcp" | "task" | "other";
  mcpServer: string | null;
  status: "ok" | "error" | "interrupted" | "unknown";
  durationMs: number | null;
  exitCode: number | null;
  inputBytes: number;
  outputBytes: number;
  argv0: string | null;
  template: string | null;
  hosts: string[];
  network: boolean;
  subagent: boolean;
};

export type SessionSecret = {
  fingerprint: string;
  type: string;
  confidence: "high" | "medium" | "low";
  prefix: string | null;
  length: number;
  occurrences: number;
  seenByModel: boolean;
  modelEmitted: boolean;
  toCommand: boolean;
  toNetwork: boolean;
  writtenToFile: boolean;
  sessions: number;
};

export type SessionLink = { kind: "work" | "pr"; target: string; artifactId: string | null; title: string | null };

export type TranscriptEvent = {
  t?: number;
  type: "prompt" | "assistant" | "tool_call" | "tool_result" | "thinking" | "unreadable";
  text?: string;
  input?: string;
  output?: string;
  seq?: number;
  tool?: string;
  status?: string;
  subagent?: boolean;
};

export type SessionList = {
  enabled: boolean;
  quotaBytes: number;
  usedBytes: number;
  /** The installation's word on who reads the sessions, if it set one. */
  notice: string | null;
  sessions: AgentSession[];
  projects: { label: string; sessions: number }[];
  next: string | null;
};

export type SessionDetail = { session: AgentSession; toolCalls: ToolCall[]; secrets: SessionSecret[]; links: SessionLink[] };

export type Fingerprint = {
  fingerprint: string;
  type: string;
  prefix: string | null;
  sessions: number;
  occurrences: number;
  toNetwork: boolean;
  toCommand: boolean;
  writtenToFile: boolean;
  seenByModel: boolean;
  lastSeen: string | null;
  lastSessionId: string;
};

export type SessionStats = {
  days: number;
  totals: { sessions: number; toolCalls: number; cost: number; withoutCost: number; someEstimated: boolean | null };
  byDay: { day: string; sessions: number; toolCalls: number; input: number; output: number; cacheRead: number; cost: number | null }[];
  byModel: { model: string; sessions: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
  secrets: Partial<Record<SecretsStatus, number>>;
  fingerprints: Fingerprint[];
  hosts: { host: string; calls: number; sessions: number }[];
  mcp: { server: string; calls: number; errors: number }[];
  alerts: { rule: AlertRule; sessions: number; count: number }[];
};

export type SessionFilters = {
  source?: SessionSource | "";
  project?: string;
  secrets?: SecretsStatus | "any" | "";
  alerts?: "any" | "";
};

/** The query string of a list request: only filters that are set. */
export function listQuery(filters: SessionFilters, before?: string | null, limit = 50) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (before) params.set("before", before);
  params.set("limit", String(limit));
  return params.toString();
}

export const sessionsApi = {
  list: (filters: SessionFilters, before?: string | null) => request<SessionList>(`/sessions?${listQuery(filters, before)}`),
  get: (id: string) => request<SessionDetail>(`/sessions/${id}`),
  transcript: (id: string, offset: number, limit = 200) =>
    request<{ events: TranscriptEvent[]; total: number; offset: number; tooLarge: boolean }>(
      `/sessions/${id}/transcript?offset=${offset}&limit=${limit}`,
    ),
  remove: (id: string) => request<{ deleted: boolean }>(`/sessions/${id}`, undefined, "DELETE"),
  stats: (days: number) => request<SessionStats>(`/sessions/stats?days=${days}`),
  ofWork: (artifactId: string) =>
    request<{ sessions: Pick<AgentSession, "id" | "source" | "projectLabel" | "startedAt" | "secretsStatus">[] }>(
      `/artifacts/${artifactId}/sessions`,
    ),
};

export const transcriptUrl = (id: string) => `/api/sessions/${id}/transcript.gz`;
export const sessionUrl = (id: string) => `/sessions/${id}`;
export const SESSION_PATH = /^\/sessions\/([a-f0-9-]{36})$/;

export const SOURCE_LABEL: Record<SessionSource, string> = { "claude-code": "Claude Code", codex: "Codex" };

export const SECRETS_LABEL: Record<SecretsStatus, string> = {
  clean: "чисто",
  seen: "модель видела секрет",
  used: "секрет в команде или файле",
  sent_out: "секрет отправлен наружу",
};
export const SECRETS_TONE: Record<SecretsStatus, "success" | "neutral" | "warning" | "danger"> = {
  clean: "success",
  seen: "neutral",
  used: "warning",
  sent_out: "danger",
};

export const ALERT_LABEL: Record<AlertRule, string> = {
  secret_sent_out: "Секрет ушёл наружу",
  destructive_command: "Разрушительная команда",
  pipe_to_shell: "Скрипт из сети в оболочку",
  no_approvals: "Без подтверждений",
};
export const ALERT_HINT: Record<AlertRule, string> = {
  secret_sent_out: "Значение, похожее на секрет, попало в вызов сетевого инструмента или MCP-сервера.",
  destructive_command: "rm -rf, git push --force, git reset --hard, terraform destroy, kubectl delete и подобные.",
  pipe_to_shell: "Скачанный скрипт сразу выполнен оболочкой (curl … | sh).",
  no_approvals: "Агент работал без подтверждения действий человеком.",
};

export const KIND_LABEL: Record<ToolCall["kind"], string> = {
  shell: "Команда",
  edit: "Правка файла",
  read: "Чтение",
  web: "Сеть",
  mcp: "MCP",
  task: "Подагент",
  other: "Другое",
};

export const STATUS_LABEL: Record<ToolCall["status"], string> = {
  ok: "успешно",
  error: "ошибка",
  interrupted: "прервано",
  unknown: "нет результата",
};

/** Where a secret went, in words: «в команде, в сеть». */
export function secretFlags(secret: Pick<SessionSecret, "seenByModel" | "modelEmitted" | "toCommand" | "toNetwork" | "writtenToFile">) {
  const flags: string[] = [];
  if (secret.toNetwork) flags.push("отправлен в сеть");
  if (secret.toCommand) flags.push("в команде");
  if (secret.writtenToFile) flags.push("записан в файл");
  if (secret.seenByModel) flags.push("модель видела");
  if (secret.modelEmitted && !secret.toNetwork && !secret.toCommand && !secret.writtenToFile) flags.push("модель написала");
  return flags;
}

export const plural = (n: number, one: string, few: string, many: string) => {
  const rule = new Intl.PluralRules("ru").select(n);
  return `${n.toLocaleString("ru-RU")} ${rule === "one" ? one : rule === "few" ? few : many}`;
};

/** 1 234 567 → «1,2 млн», 12 345 → «12 тыс.». */
export function compactNumber(n: number) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млрд`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`;
  if (n >= 1e4) return `${Math.round(n / 1e3).toLocaleString("ru-RU")} тыс.`;
  return Math.round(n).toLocaleString("ru-RU");
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
}

/** «$12.40», «оценка» marked by the caller; null → «—». */
export function formatCost(cost: number | null | undefined) {
  if (cost === null || cost === undefined) return "—";
  return `$${cost < 10 ? cost.toFixed(2) : Math.round(cost).toLocaleString("en-US")}`;
}

/** «3 мин», «2 ч 15 мин», «1 д 4 ч». */
export function formatDuration(ms: number | null | undefined) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} мс`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} с`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`;
  return `${Math.floor(hours / 24)} д${hours % 24 ? ` ${hours % 24} ч` : ""}`;
}

export const sessionDuration = (session: Pick<AgentSession, "startedAt" | "endedAt">) =>
  session.startedAt && session.endedAt ? Date.parse(session.endedAt) - Date.parse(session.startedAt) : null;

export function formatWhen(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Permission modes in words; unknown ones as they are. */
export function permissionLabel(mode: string | null) {
  if (!mode) return "—";
  const known: Record<string, string> = {
    default: "с подтверждениями",
    acceptEdits: "правки без подтверждения",
    plan: "режим плана",
    bypassPermissions: "без подтверждений",
    "never/danger-full-access": "без подтверждений, полный доступ",
  };
  return known[mode] ?? mode;
}

/** The bar width of `value` against `max`, as a CSS percentage. */
export const barWidth = (value: number, max: number) => `${max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0}%`;
