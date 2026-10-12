import { z } from "zod";

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

const events = z
  .array(z.enum(WEBHOOK_EVENTS, { message: "Неизвестное событие." }))
  .min(1, "Выберите хотя бы одно событие.")
  .max(WEBHOOK_EVENTS.length)
  .transform((list) => WEBHOOK_EVENTS.filter((event) => list.includes(event)));
const url = z.string().trim().min(1, "Укажите адрес.").max(WEBHOOK_URL_MAX, "Адрес — до 2000 символов.");
const description = z.string().trim().max(200, "Описание — до 200 символов.");

export const createWebhookInput = z.object({ url, description: description.default(""), events }).strict();
export const updateWebhookInput = z
  .object({
    url: url.optional(),
    description: description.optional(),
    events: events.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type Webhook = {
  id: string;
  url: string;
  description: string;
  events: WebhookEvent[];
  status: "active" | "disabled";
  /** Why it is off: the owner switched it off, or Полка did after failing deliveries. */
  disabledReason: "owner" | "failures" | "creator" | null;
  /** The secret's first characters, to tell which one the receiver holds. */
  secretHint: string;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  /** The address fails again and again: nothing is sent to it until then. */
  pausedUntil: string | null;
  /** Events not queued because too many already waited for this address. */
  skippedEvents: number;
};

export type WebhookDelivery = {
  id: string;
  eventId: string;
  action: string;
  state: "pending" | "delivered" | "failed";
  attempts: number;
  lastStatus: number | null;
  /** timeout, blocked_address, redirect, connection, http… */
  lastError: string | null;
  /** The first characters of the receiver's answer, nothing more is kept. */
  responseSnippet: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
};
