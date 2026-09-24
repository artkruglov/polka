// The recipient page's prompt («Эту страницу сделали с ИИ и сохранили на
// Полку»): a guest saw it or pressed something in it (analytics.ts,
// docs/specs/RECIPIENT_CONVERSION.md).
//
//   POST /api/recipient-cta  {event:"view", surface} | {event:"click", action}
//
// Answers 204 whatever happens to the count. Nothing identifies the link or
// the person: the body is two enumerated words, the browser-POST Origin check
// in app.ts applies, a signed-in viewer or a bot is not counted, and the
// limit counts per hashed client IP.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  isHumanAgent,
  RECIPIENT_CTA_ACTIONS,
  RECIPIENT_CTA_SURFACES,
  trackRecipientCta,
} from "./analytics.ts";
import { limitAttempts } from "./auth.ts";

/** Events per client IP per hour: a page fires two or three. */
export const RECIPIENT_CTA_PER_IP = 240;

export const recipientCtaSchema = z.union([
  z.object({ event: z.literal("view"), surface: z.enum(RECIPIENT_CTA_SURFACES) }).strict(),
  z.object({ event: z.literal("click"), action: z.enum(RECIPIENT_CTA_ACTIONS) }).strict(),
]);

export function registerRecipientCta(app: FastifyInstance) {
  app.post("/api/recipient-cta", { bodyLimit: 256 }, async (req, reply) => {
    const input = recipientCtaSchema.parse(req.body);
    const agent = req.headers["user-agent"];
    if (!req.cookies.polka_session && isHumanAgent(agent)) {
      await limitAttempts(`recipient-cta:ip:${req.ip}`, RECIPIENT_CTA_PER_IP, "1 hour");
      trackRecipientCta(input);
    }
    return reply.code(204).send();
  });
}
