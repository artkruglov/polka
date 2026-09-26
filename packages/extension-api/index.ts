// The extension API of Полка's open core (docs/specs/EXTENSIONS.md). An
// extension is a module named in POLKA_EXTENSIONS whose default export is a
// PolkaExtension. Without extensions every hook is empty and the core behaves
// exactly as it does alone.
//
// This file is part of the open core (AGPL-3.0). An extension keeps its own
// tables in its own PostgreSQL schema, with its own migrations and role
// grants: the core's migration set and grant recipes never change for it.
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
  };
  /** After the fact, outside the transaction: integrations and journals. Errors are logged, never thrown. */
  onEvent?(event: PolkaEvent): Promise<void> | void;
  /**
   * The extension's part of the web app: an absolute path to one ES module
   * the core serves as /ext/<name>.js. The app loads it and it registers its
   * sections through window.__polkaHost (see ExtensionHost).
   */
  web?: { script: string };
}

export type { ExtensionHost, ExtensionSlot } from "../contracts/extensions.ts";
