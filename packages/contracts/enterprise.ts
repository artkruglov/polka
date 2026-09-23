import { z } from "zod";
import {
  ENTERPRISE_INTERESTS,
  ENTERPRISE_LIMITS,
  ENTERPRISE_TEAM_SIZES,
} from "./constants.ts";

// One line of text: no control characters, so a field never breaks the
// letter's subject or layout.
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value));

/** POST /api/enterprise-requests: a company asks about Полка (/enterprise). */
export const enterpriseRequestSchema = z
  .object({
    /** Idempotency: a repeated submit of the same form is one request. */
    key: z.string().uuid(),
    name: line(ENTERPRISE_LIMITS.name),
    company: line(ENTERPRISE_LIMITS.company),
    email: z
      .string()
      .trim()
      .email()
      .max(ENTERPRISE_LIMITS.email)
      .transform((value) => value.toLowerCase()),
    teamSize: z.enum(ENTERPRISE_TEAM_SIZES),
    interest: z.enum(ENTERPRISE_INTERESTS),
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
