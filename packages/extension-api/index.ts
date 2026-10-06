// The extension API of Полка's open core (docs/specs/EXTENSIONS.md). An
// extension is a module named in POLKA_EXTENSIONS whose default export is a
// PolkaExtension. Without extensions every hook is empty and the core behaves
// exactly as it does alone.
//
// This file is part of the open core (AGPL-3.0). An extension keeps its own
// tables in its own PostgreSQL schema, with its own migrations and role
// grants: the core's migration set and grant recipes never change for it.
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

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

/** What the core hands an extension when it registers. */
export type ExtensionContext = {
  /** The signed-in account; with { shelf: true } it follows X-Polka-Shelf. */
  identity: (req: FastifyRequest, options?: { shelf?: boolean }) => Promise<ExtensionActor>;
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
