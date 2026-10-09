import { z } from "zod";
import { ENTERPRISE_INTERESTS, ENTERPRISE_LIMITS, ENTERPRISE_TEAM_SIZES } from "./constants.ts";

// One line of text: no control characters, so a field never breaks the
// letter's subject or layout.
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value));

/** A Telegram username: 5–32 letters, digits or underscores. */
const TELEGRAM = /^[a-z][a-z0-9_]{4,31}$/i;

/**
 * How to reach the person: a work e-mail (lower-cased) or a Telegram
 * username — «@name», «name» or «t.me/name» all become «@name».
 */
export const enterpriseContact = z
  .string()
  .trim()
  .max(ENTERPRISE_LIMITS.email)
  .transform((value, ctx) => {
    if (z.string().email().safeParse(value).success) return value.toLowerCase();
    const handle = value.replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i, "").replace(/^@/, "");
    if (TELEGRAM.test(handle)) return `@${handle}`;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Почта или имя в Telegram" });
    return z.NEVER;
  });

/** Is this contact an e-mail (a letter can be answered), not a Telegram name? */
export const isEmailContact = (contact: string) => !contact.startsWith("@");

/**
 * POST /api/enterprise-requests: a company asks about Полка (/enterprise).
 * One field is enough — how to reach the person; the rest is optional.
 */
export const enterpriseRequestSchema = z
  .object({
    /** Idempotency: a repeated submit of the same form is one request. */
    key: z.string().uuid(),
    contact: enterpriseContact,
    name: line(ENTERPRISE_LIMITS.name).optional(),
    company: line(ENTERPRISE_LIMITS.company).optional(),
    teamSize: z.enum(ENTERPRISE_TEAM_SIZES).optional(),
    interest: z.enum(ENTERPRISE_INTERESTS).default("other"),
    // Line breaks stay; other control characters do not.
    comment: z
      .string()
      .max(ENTERPRISE_LIMITS.comment)
      .transform((value) =>
        value
          .replace(/\r\n?/g, "\n")
          .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
          .trim(),
      )
      .optional(),
    /** The person confirms they read the privacy policy (not a consent). */
    policyRead: z.literal(true),
    /** Honeypot: hidden from people; a bot that fills it gets a quiet no-op. */
    website: z.string().max(500).optional(),
  })
  .strict();
export type EnterpriseRequestInput = z.input<typeof enterpriseRequestSchema>;
