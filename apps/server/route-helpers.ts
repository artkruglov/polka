import { z } from "zod";
import { config } from "./config.ts";
import { assertStrongSession, identity } from "./auth.ts";
import { Problem } from "./errors.ts";
import { uuid } from "../../packages/contracts/index.ts";

const viewOptions = z.object({ comments: z.boolean().optional() }).strict();

/**
 * Routes of the shelf itself — works, folders, uploads, trash, views — follow
 * the shelf the web app has open (X-Polka-Shelf, docs/specs/TEAM_SHELVES.md).
 */
export const SHELF = { shelf: true } as const;

/**
 * Not signed in (401) or not allowed (403) reads as anonymous; any other
 * failure — the database down — is the request's failure, not a guest's.
 */
export function anonymous(error: unknown): null {
  if (error instanceof Problem && (error.status === 401 || error.status === 403)) return null;
  throw error;
}

export const id = (req: any) => uuid.parse(req.params.id);

/** Agents, tokens and deletion need a real sign-in, not an agent's link. */
export const strongIdentity = async (
  req: Parameters<typeof identity>[0],
  options: Parameters<typeof identity>[1] = {},
) => {
  const actor = await identity(req, options);
  assertStrongSession(actor);
  return actor;
};

/**
 * The shell asks for the comment overlay when it issues a view grant; the
 * flag lives in the grant, never in a URL anyone could open.
 * COMMENTS_MODE=off: no overlay at all, whatever the shell asks.
 */
export const withComments = (req: any) =>
  viewOptions.parse(req.body ?? {}).comments === true && config.COMMENTS_MODE !== "off";
