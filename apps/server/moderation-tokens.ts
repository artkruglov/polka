// Signed one-click moderation links (docs/specs/ABUSE_PROTECTION.md, 5):
// APP_ORIGIN/moderation#<token>. The token sits in the fragment, so it never
// reaches server or proxy logs. Opening the page (GET) changes nothing: mail
// scanners open links on their own. Only a POST with the token acts, and every
// action is idempotent.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "./config.ts";

export const MODERATION_ACTIONS = [
  "preview",
  "approve",
  "approve-trust",
  "unpause",
  "close",
  "close-disable",
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const MODERATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A distinct purpose, so no other HMAC of LINK_KEY can pass for a token. */
const PURPOSE = "polka/moderation-action/v1";
export const MODERATION_TOKEN = /^[A-Za-z0-9_-]{20,400}\.[A-Za-z0-9_-]{43}$/;

const payloadSchema = z
  .object({
    v: z.literal(1),
    a: z.enum(MODERATION_ACTIONS),
    s: z.string().uuid(),
    e: z.number().int().positive(),
  })
  .strict();

const key = () =>
  createHmac("sha256", config.LINK_KEY).update(PURPOSE).digest();
const sign = (payload: string) =>
  createHmac("sha256", key()).update(payload).digest("base64url");

export function signModerationToken(
  action: ModerationAction,
  shareId: string,
  now = Date.now(),
) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      a: action,
      s: shareId,
      e: Math.floor((now + MODERATION_TOKEN_TTL_MS) / 1000),
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export type ModerationToken = {
  action: ModerationAction;
  shareId: string;
  expiresAt: Date;
};

/** The action a genuine, unexpired token names; null for anything else. */
export function verifyModerationToken(
  token: string,
  now = Date.now(),
): ModerationToken | null {
  if (typeof token !== "string" || !MODERATION_TOKEN.test(token)) return null;
  const [payload, signature] = token.split(".");
  const expected = Buffer.from(sign(payload), "base64url");
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  let parsed: z.infer<typeof payloadSchema>;
  try {
    parsed = payloadSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
  if (parsed.e * 1000 <= now) return null;
  return {
    action: parsed.a,
    shareId: parsed.s,
    expiresAt: new Date(parsed.e * 1000),
  };
}

export const moderationUrl = (action: ModerationAction, shareId: string) =>
  `${config.APP_ORIGIN}/moderation#${signModerationToken(action, shareId)}`;
