// Zod-free part of the webhook contract (webhooks.ts) for the browser: the
// settings section lists the events without bringing zod into the app's
// initial chunk (tests/web-entry-chunk.test.ts).

/**
 * Webhooks of a shelf (docs/specs/WEBHOOKS.md): what Полка may send to an
 * address the shelf's owner or admin registered. The first seven are the
 * actions of the agents' feed (GET /api/v1/events); links and comments are
 * webhooks only.
 */
export const WEBHOOK_EVENTS = [
  "revision.saved",
  "revision.accepted",
  "owner.changed",
  "artifact.metadata_updated",
  "artifact.moved",
  "artifact.trashed",
  "artifact.restored",
  "share.enabled",
  "share.revoked",
  "comment.created",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const MAX_WEBHOOKS_PER_SHELF = 10;
export const WEBHOOK_URL_MAX = 2000;
