// Sign-ins that wait for the person's answer (docs/specs/SIGN_IN_PROVIDERS.md
// § 1 «Уже есть полка?» and § 8 «Закрепить полку»).
//
//   choice     A provider sign-in would open a NEW shelf in a browser that
//              remembers another one: /signup/choose asks «войти в
//              существующую или создать новую».
//   collision  A browser with a provisional shelf proved it owns another,
//              existing shelf (a provider, a code, a password): /claim offers
//              «Объединить».
//
// What the provider told us stays in this process's memory for ten minutes
// and never reaches a URL, a log or the database. The browser holds only a
// sealed cookie naming the entry; a restart forgets every entry and the
// person simply starts again.
import { randomBytes } from "node:crypto";
import type { VisitSource } from "./analytics.ts";
import {
  openValue,
  sealValue,
  type ProviderProfile,
} from "./sign-in-providers.ts";

export const PENDING_TTL_SECONDS = 600;
const MAX_ENTRIES = 5000;

export type ChoiceEntry = {
  kind: "choice";
  profile: ProviderProfile;
  next: string;
  source: VisitSource | null;
};

export type CollisionEntry = {
  kind: "collision";
  /** The provisional shelf this browser is signed in to. */
  provisionalId: string;
  /** The existing shelf the browser proved it owns. */
  targetId: string;
  /** A session of the target already issued (a code or a password). */
  targetSession: string | null;
  /** A provider identity to link to the target once the shelves are one. */
  profile: ProviderProfile | null;
  /** How the browser proved it: "email", "password" or a provider id. */
  method: string;
};

type Entry = (ChoiceEntry | CollisionEntry) & { expires: number };
type Kind = Entry["kind"];

const entries = new Map<string, Entry>();

function prune(now: number) {
  for (const [id, entry] of entries)
    if (entry.expires <= now) entries.delete(id);
  // Oldest first (a Map keeps insertion order): memory stays bounded even
  // under a flood of abandoned sign-ins.
  while (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

const labels: Record<Kind, string> = {
  choice: "polka:idp-pending:v1",
  collision: "polka:claim-collision:v1",
};

/** Keeps the entry; returns the sealed cookie value that names it. */
export function holdPending(entry: ChoiceEntry | CollisionEntry) {
  const now = Date.now();
  prune(now);
  const id = randomBytes(24).toString("base64url");
  const expires = now + PENDING_TTL_SECONDS * 1000;
  entries.set(id, { ...entry, expires });
  return sealValue({ id, expires }, labels[entry.kind]);
}

function find<K extends Kind>(cookie: string | undefined, kind: K) {
  const sealed = openValue<{ id: string; expires: number }>(
    cookie,
    labels[kind],
  );
  if (!sealed) return null;
  const entry = entries.get(sealed.id);
  if (!entry || entry.kind !== kind || entry.expires <= Date.now()) {
    entries.delete(sealed.id);
    return null;
  }
  return {
    id: sealed.id,
    entry: entry as Extract<Entry, { kind: K }>,
  };
}

/** The entry the cookie names, left in place. */
export function peekPending<K extends Kind>(
  cookie: string | undefined,
  kind: K,
) {
  return find(cookie, kind)?.entry ?? null;
}

/** The entry the cookie names, removed: it is used once. */
export function takePending<K extends Kind>(
  cookie: string | undefined,
  kind: K,
) {
  const found = find(cookie, kind);
  if (!found) return null;
  entries.delete(found.id);
  return found.entry;
}

/** Tests: forget everything, or make every entry older than it is. */
export const pendingForTests = {
  clear: () => entries.clear(),
  expireAll: () => {
    for (const entry of entries.values()) entry.expires = Date.now() - 1;
  },
  size: () => entries.size,
};
