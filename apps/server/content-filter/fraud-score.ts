// The fraud (phishing) score of a page's phishing signals
// (phishing-signals.ts; docs/specs/CONTENT_FILTER.md, «Фишинг»).
//
// Nothing typed into a page on Полка can leave it (the viewer's CSP and
// sandbox), so a login form, a card form, brand names and «подтвердите»
// score nothing on their own: that is every prototype of a B2B product and
// every shop. A page scores only when it sends the reader off the page:
//
//   strong channel (6): asks to hand over a code, a password or card details
//     (channel:handover), to transfer money (channel:transfer,
//     channel:crypto), or to sign in on a look-alike of a brand's site
//     (channel:lookalike-login);
//   look-alike domain (4): a brand inside a host that is not the brand's
//     (lookalike:*);
//   weak channel (+2, never on its own): a Telegram/WhatsApp contact, a
//     phone to call, an address to write to, a sign-in page elsewhere
//     (channel:messenger, channel:phone, channel:email, channel:login-link).
//
// With one of the first two, the rest adds: a request for a secret +3,
// urgency +2, a brand +2 (only next to a strong channel). The category's
// threshold is 6 and its high score 10 (lists.ts).

export type FraudScore = {
  score: number;
  /** At or above the fraud threshold. */
  suspicious: boolean;
};

const STRONG = new Set([
  "channel:handover",
  "channel:transfer",
  "channel:crypto",
  "channel:lookalike-login",
]);
const WEAK = new Set([
  "channel:messenger",
  "channel:phone",
  "channel:email",
  "channel:login-link",
]);
/** The fraud list's threshold (lists.ts: fraud.threshold). */
export const FRAUD_THRESHOLD = 6;

export function fraudScoreOf(signals: readonly string[]): FraudScore {
  const has = (prefix: string) => signals.some((signal) => signal.startsWith(prefix));
  const strong = signals.some((signal) => STRONG.has(signal));
  const lookalike = has("lookalike:");
  if (!strong && !lookalike) return { score: 0, suspicious: false };
  const score =
    (strong ? 6 : 4) +
    (signals.some((signal) => WEAK.has(signal)) ? 2 : 0) +
    (has("secret:") ? 3 : 0) +
    (has("urgency:") ? 2 : 0) +
    (strong && has("brand:") ? 2 : 0);
  return { score, suspicious: score >= FRAUD_THRESHOLD };
}

/**
 * The phishing signals that decide the score: what an operator's approval
 * covers (shares.ts, approvedSignalsCover). Links and an unread page are not
 * among them.
 */
export const fraudRelevant = (signals: readonly string[]) =>
  signals.filter((signal) => /^(?:secret|brand|urgency|channel|lookalike):/.test(signal));
