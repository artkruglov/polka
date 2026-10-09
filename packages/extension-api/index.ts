// The extension API of Полка's open core (docs/specs/EXTENSIONS.md). An
// extension is a module named in POLKA_EXTENSIONS whose default export is a
// PolkaExtension. Without extensions every hook is empty and the core behaves
// exactly as it does alone.
//
// This file is part of the open core (AGPL-3.0). An extension keeps its own
// tables in its own PostgreSQL schema, with its own migrations and role
// grants: the core's migration set and grant recipes never change for it.
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import type { AgentScope } from "../contracts/index.ts";

export type { AgentScope };

export type ShelfRole = "owner" | "admin" | "curator" | "author" | "reader";

/** The signed-in account and the shelf a request works on (the core's identity()). */
export type ExtensionActor = {
  id: string;
  name: string;
  tenant: string;
  role: ShelfRole;
};

export type ShelfInfo = { id: string; kind: "personal" | "team"; name: string | null };

/** An agent's connection; a project upload token is reported as the connection that asked for it. */
export type AgentConnectionInfo = { connectionId: string; accountId: string; tenantId: string };

/** A link about to be issued (or moved to a new version). */
export type LinkIssue = {
  actor: { id: string; tenant: string };
  shelf: ShelfInfo;
  artifactId: string;
  revisionId: string;
  expiresInDays: number;
  via: "web" | "agent";
};

/** A link about to open for a recipient. */
export type LinkOpen = {
  shareId: string;
  shelf: ShelfInfo;
  artifactId: string;
  /** The recipient's account when the browser is signed in to this installation. */
  viewer: { id: string } | null;
};

export type LinkIssueDecision =
  | { allow: true }
  | { allow: false; message: string };

export type LinkOpenDecision =
  | { allow: true }
  /** The recipient must sign in to this installation first (e.g. employees only). */
  | { allow: false; signIn: true; message: string }
  | { allow: false; signIn?: false; message: string };

/** A person about to delete one of their agent sessions (docs/specs/AGENT_SESSIONS.md). */
export type SessionDelete = {
  actor: { id: string; tenant: string };
  sessionId: string;
  source: "claude-code" | "codex";
  startedAt: string | null;
};

export type SessionDeleteDecision =
  | { allow: true }
  | { allow: false; message: string };

export type PolkaEvent =
  | { type: "revision.saved"; tenantId: string; artifactId: string; revisionId: string; accountId: string; at: string }
  | { type: "share.created"; tenantId: string; artifactId: string; shareId: string; revisionId: string; accountId: string; at: string }
  | { type: "share.revoked"; tenantId: string; shareId: string; accountId: string | null; at: string }
  | { type: "member.revoked"; tenantId: string; accountId: string; at: string };

/** A file of a saved version, as the version records it. */
export type ExtensionRevisionFile = { index: number; path: string; mime: string; size: number; sha256: string };

/** A saved version with its work and shelf (context.content.revision). */
export type ExtensionRevision = {
  shelf: ShelfInfo;
  artifact: {
    id: string;
    title: string;
    folder: { id: string; name: string } | null;
    trashed: boolean;
    acceptedRevisionId: string | null;
  };
  revision: {
    id: string;
    number: number;
    createdAt: string;
    manifestSha256: string | null;
    entrypoint: string;
    runtime: string | null;
  };
  files: ExtensionRevisionFile[];
  /** null: the bytes may be read; otherwise moderation isolated ("blocked") or deleted ("removed") them. */
  unavailable: null | "blocked" | "removed";
};

/** A row of the installation's action journal (context.auditFeed). */
export type AuditFeedItem = {
  id: string;
  tx: string;
  tenantId: string;
  actorId: string;
  actorType: string;
  action: string;
  targetId: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};
/** A place in the journal; keep it in your own table and pass it back. */
export type AuditCursor = { tx: string; id: string };

export type PdfOutcome =
  | { pdf: Buffer }
  | {
      skipped:
        | "not_visual"
        | "no_source"
        | "too_large"
        | "timeout"
        | "busy"
        | "failed"
        | "renderer_outdated"
        | "unavailable";
    };

/** Agent sessions of the installation (docs/specs/AGENT_SESSIONS.md); accounts limits them to these people. */
export type SessionSelection = { accounts?: string[] };

export type SessionListQuery = {
  source?: "claude-code" | "codex";
  project?: string;
  secrets?: "clean" | "seen" | "used" | "sent_out" | "any";
  alerts?: "any";
  /** The previous page's next, passed back as is (a start time and an id). */
  before?: string;
  limit?: number;
};

export type SessionAlertRule = "secret_sent_out" | "destructive_command" | "pipe_to_shell" | "no_approvals";

export type ExtensionSession = {
  id: string;
  accountId: string;
  source: "claude-code" | "codex";
  externalId: string;
  projectLabel: string | null;
  projectRemote: string | null;
  gitBranch: string | null;
  cliVersion: string | null;
  permissionMode: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  turns: number;
  prompts: number;
  toolCallCount: number;
  tokens: Record<string, number>;
  models: Record<string, Record<string, number>>;
  costUSD: number | null;
  costEstimated: boolean;
  secretsStatus: "clean" | "seen" | "used" | "sent_out";
  alerts: Array<{ rule: SessionAlertRule; count: number; firstSeq: number | null }>;
  transcriptBytes: number;
  uploadedAt: Date;
  updatedAt: Date;
};

/** What the person's own session page shows: tool calls, secrets (no values) and links. */
export type ExtensionSessionDetail = {
  session: ExtensionSession;
  toolCalls: Array<Record<string, unknown>>;
  secrets: Array<Record<string, unknown>>;
  links: Array<{ kind: "work" | "pr"; target: string; artifactId: string | null; title: string | null }>;
};

/**
 * Text with secrets replaced by [REDACTED:<type>:<fingerprint>], as the
 * sessions CLI replaces them on the machines, and each secret found (never
 * its value).
 */
export type RedactResult = { text: string; secrets: Array<{ type: string; fingerprint: string }> };

/** What the core hands an extension when it registers. */
export type ExtensionContext = {
  /**
   * The signed-in account; with { shelf: true } it follows X-Polka-Shelf.
   * Refuses (403) on the extension's machinePaths: no Origin check there.
   */
  identity: (req: FastifyRequest, options?: { shelf?: boolean }) => Promise<ExtensionActor>;
  /**
   * An agent token (Authorization: Bearer, no cookies) with this permission,
   * checked as the core's /api/v1 routes check it: 401 without a valid token,
   * 403 without the permission, 429 over the connection's rate. For an
   * extension's machinePaths.
   */
  agent: (req: FastifyRequest, reply: FastifyReply, scope: AgentScope) => Promise<AgentConnectionInfo>;
  /** A transaction on the application's database role. */
  transaction: <T>(work: (c: PoolClient) => Promise<T>) => Promise<T>;
  /**
   * An error the core answers with this status, code and message (the person
   * reads the message), e.g. fail(404, "not_found", "…").
   */
  fail: (
    status: number,
    code: "invalid" | "unauthorized" | "not_found" | "conflict" | "forbidden" | "quota",
    message: string,
  ) => Error;
  /** The core's installation settings an extension may read. */
  settings: { appOrigin: string; teamShelves: boolean };
  log: (event: Record<string, unknown>) => void;
  /**
   * Saved versions of any shelf of the installation (an extension is trusted
   * code in the core's process). Moderation and checksums stay the core's:
   * an isolated version is reported, never read; every stream is checked
   * against the version's record and fails at its end on a mismatch.
   */
  content: {
    revision(tenantId: string, revisionId: string): Promise<ExtensionRevision | null>;
    openFile(tenantId: string, revisionId: string, index: number): Promise<Readable>;
    /** The page a recipient would see, printed on A4; null where the renderer is not configured. */
    pdf: ((tenantId: string, revisionId: string, signal?: AbortSignal) => Promise<PdfOutcome>) | null;
  };
  /**
   * The action journal of the whole installation in commit order (audit_outbox).
   * Durable where onEvent is not: keep the cursor and nothing is lost on a
   * restart; a transaction that commits late is never skipped.
   */
  /**
   * Agent sessions of every person of the installation: the reads behind the
   * person's own pages, across people. Secrets are already replaced on the
   * machines; no values exist here. Reading a transcript is the extension's
   * to record (the core does not log reads). A missing session throws the
   * core's 404.
   */
  sessions: {
    list(selection: SessionSelection, query?: SessionListQuery): Promise<{ sessions: ExtensionSession[]; projects: Array<{ label: string; sessions: number }>; next: string | null }>;
    get(sessionId: string, selection?: SessionSelection): Promise<ExtensionSessionDetail>;
    /** «Секреты» and «Расход» across people, plus people: totals by person. */
    stats(selection: SessionSelection, query?: { days?: number }): Promise<Record<string, unknown>>;
    /** A page of the transcript's events. */
    transcript(sessionId: string, query?: { offset?: number; limit?: number }): Promise<{ events: unknown[]; total: number; offset: number; tooLarge: boolean }>;
    /** The whole transcript, gzipped JSON lines. */
    transcriptFile(sessionId: string): Promise<{ bytes: Buffer; name: string }>;
  };
  /**
   * Secrets out of text that reaches the server unredacted, e.g. agent
   * telemetry (OTLP): the rules and markers of scripts/polka-sessions.mjs. The
   * fingerprint is keyed with the installation key, so it equals an uploaded
   * session's under AGENT_SESSION_FINGERPRINTS=installation; with per-shelf
   * keys (the default) the two never match. Synchronous, no I/O.
   */
  redact(text: string): RedactResult;
  auditFeed: {
    read(
      after: AuditCursor | null,
      options: { actions: string[]; limit: number },
    ): Promise<{ items: AuditFeedItem[]; next: AuditCursor | null }>;
    /** The end of the journal now: start here to see only what comes next. */
    head(): Promise<AuditCursor>;
  };
};

export interface PolkaExtension {
  /** A short name, e.g. "enterprise"; routes live under /api/ext/<name>/. */
  name: string;
  /** Registers routes and background work. Called once, after the core's routes. */
  register?(app: FastifyInstance, context: ExtensionContext): Promise<void> | void;
  /**
   * Exact paths of the extension's machine routes, under /api/ext/<name>/:
   * called by agents and collectors (e.g. OTLP exporters) with an agent
   * token, without a browser Origin. The core exempts them from its Origin
   * rule; their handlers authenticate with context.agent only.
   */
  machinePaths?: string[];
  policies?: {
    /** Before a link is issued or moved: refuse with a message the person reads. */
    linkIssue?(issue: LinkIssue, c: PoolClient): Promise<LinkIssueDecision>;
    /** Before a link opens for a recipient. */
    linkOpen?(open: LinkOpen, c: PoolClient): Promise<LinkOpenDecision>;
    /**
     * The folders an agent's connection is limited to, or null for the whole
     * shelf. The core applies it to every agent action (apps/server/
     * agent-scope.ts): works outside are «not found», new works go to these
     * folders, and the agent does not manage folders.
     */
    agentScope?(connection: AgentConnectionInfo, c: Pick<PoolClient, "query">): Promise<{ folderIds: string[] } | null>;
    /**
     * Before a person deletes one of their agent sessions: refuse with a
     * message they read (e.g. the company keeps sessions for a term). Erasing
     * the whole account is never asked.
     */
    sessionDelete?(input: SessionDelete, c: PoolClient): Promise<SessionDeleteDecision>;
  };
  /**
   * After the fact, outside the transaction: best effort, at most once (lost
   * on a restart). Errors are logged, never thrown. For work that must not be
   * lost, read context.auditFeed by a cursor instead.
   */
  onEvent?(event: PolkaEvent): Promise<void> | void;
  /**
   * The extension's part of the web app: an absolute path to one ES module
   * the core serves as /ext/<name>.js. The app loads it and it registers its
   * sections through window.__polkaHost (see ExtensionHost).
   */
  web?: { script: string };
}

export type {
  AgentConnectionSlotProps,
  ExtensionHost,
  ExtensionSlot,
  ShareDialogSlotProps,
} from "../contracts/extensions.ts";
