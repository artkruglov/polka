// Secrets in agent sessions (stage 0 of the agent sessions plan; the future
// polka-sessions CLI uses the same code): find them in a string, replace each
// with [REDACTED:<type>:<fp>] and report the type, a keyed fingerprint and
// where it was seen. A value never leaves this function. Dependency-free.
import { createHmac } from "node:crypto";

/** Rule families after gitleaks' defaults; bounded repetition only. */
export const RULES = [
  { type: "private-key", confidence: "high", re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{16,8192}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g },
  { type: "aws-access-key", confidence: "high", re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g },
  { type: "github-token", confidence: "high", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/g },
  { type: "gitlab-token", confidence: "high", re: /\bglpat-[\w-]{20}\b/g },
  { type: "anthropic-key", confidence: "high", re: /\bsk-ant-(?:api03|admin01|oat01)-[\w-]{80,}/g },
  { type: "openai-key", confidence: "high", re: /\bsk-(?:proj-|svcacct-|admin-)?[\w-]{20,}T3BlbkFJ[\w-]{20,}|\bsk-proj-[\w-]{40,}/g },
  { type: "yandex-iam-token", confidence: "high", re: /\bt1\.[\w-]+=*\.[\w-]{86}=*/g },
  { type: "yandex-api-key", confidence: "high", re: /\bAQVN[\w-]{35,38}\b/g },
  { type: "yandex-oauth-token", confidence: "high", re: /\by0_[\w-]{55}\b/g },
  { type: "yandex-static-key", confidence: "high", re: /\bYC[\w-]{38}\b/g },
  { type: "google-api-key", confidence: "high", re: /\bAIza[\w-]{35}\b/g },
  { type: "slack-token", confidence: "high", re: /\bxox[baprs]-[\w-]{10,}/g },
  { type: "stripe-key", confidence: "high", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/g },
  { type: "telegram-bot-token", confidence: "high", re: /\b\d{8,10}:AA[\w-]{33}\b/g },
  { type: "npm-token", confidence: "high", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { type: "huggingface-token", confidence: "high", re: /\bhf_[A-Za-z]{34}\b/g },
  { type: "jwt", confidence: "high", re: /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g },
  // Only the password of a URL with credentials.
  { type: "url-password", confidence: "high", group: 1, re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`]{1,100}:([^\s@/'"`]{4,200})@[\w.-]+/gi },
  { type: "auth-header", confidence: "medium", group: 1, re: /\b(?:authorization|x-api-key|api-key|x-auth-token)["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token|Api-Key|OAuth)?\s*([A-Za-z0-9+/_.=-]{16,})/gi },
  { type: "assignment", confidence: "medium", group: 1, re: /\b[A-Za-z_][A-Za-z0-9_]{0,60}(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET|CREDENTIALS?|DSN)[A-Za-z0-9_]{0,30}["']?[ \t]*[:=][ \t]*["']?([^\s"'`,;\\%][^\s"'`,;\\]{7,299})/gi },
];

const PLACEHOLDER = /^(?:changeme|x{3,}|\*{3,}|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|(?:process\.env|os\.environ)\b.*|your[-_].*|example.*|dummy.*|test|null|undefined|true|false|none|\[REDACTED.*)$/i;

/**
 * Code, not a value: a call, an interpolation, a dotted name, a bare word.
 * Measured on stage 0: most "PASSWORD = …" hits in sessions are code.
 */
const LOOKS_LIKE_CODE = (value) =>
  /[(){}[\]<>$`]/.test(value) ||
  /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(value) ||
  /^[A-Za-z_]+$/.test(value) ||
  /^(?:string|number|boolean|str|int|bytes|optional|required|secret|password|token)\b/i.test(value);

/** Already a fingerprint marker, a hash, a UUID or a path: not a secret value. */
const NOT_SECRET = (value) =>
  PLACEHOLDER.test(value) ||
  /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
  /^[./~]/.test(value);

function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

/**
 * A redactor with one fingerprint key. `redact(text, where)` returns the text
 * with secrets replaced; findings accumulate per fingerprint.
 */
export function createRedactor(key) {
  const findings = new Map();
  const fp = (value) => createHmac("sha256", key).update(value).digest("hex").slice(0, 12);
  const samples = [];
  /** For tuning the rules: the shape of a value and its masked surroundings, never the value. */
  const shape = (value) => value.replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").replace(/[0-9]/g, "9").replace(/(.)\1{3,}/g, "$1…");
  let context = "";
  function note(type, confidence, value, where) {
    if (samples.length < 50 && Math.random() < 0.05) {
      const at = context.indexOf(value);
      samples.push({ type, where, shape: shape(value).slice(0, 40), before: at >= 0 ? context.slice(Math.max(0, at - 40), at).replace(/[A-Za-z0-9]{6,}/g, (w) => (/^[a-z_]+$/i.test(w) ? w : shape(w))) : "", length: value.length });
    }
    const id = fp(value);
    const prefix = (/^(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|github_pat_|glpat-|AKIA|ASIA|xox[a-z]-|AIza|y0_|t1\.|AQVN|eyJ|npm_|hf_)/.exec(value) ?? [""])[0];
    const entry = findings.get(id) ?? { type, confidence, fp: id, prefix, length: value.length, occurrences: 0, where: {} };
    entry.occurrences++;
    entry.where[where] = (entry.where[where] ?? 0) + 1;
    findings.set(id, entry);
    return `[REDACTED:${type}:${id}]`;
  }
  function redact(text, where = "unknown") {
    if (typeof text !== "string" || text.length < 8) return text;
    context = text;
    let out = text;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, (match, ...groups) => {
        const value = rule.group ? groups[rule.group - 1] : match;
        if (!value || NOT_SECRET(value)) return match;
        if (rule.confidence !== "high" && LOOKS_LIKE_CODE(value)) return match;
        const marker = note(rule.type, rule.confidence, value, where);
        return rule.group ? match.replace(value, marker) : marker;
      });
    }
    // A random-looking token right after a key-like word ("api_key = …",
    // "token: …"), as gitleaks' generic rule: entropy alone flags images,
    // minified code and hashes by the million (stage 0 measurement).
    out = out.replace(
      /\b(?:key|token|secret|passw(?:or)?d|auth|bearer|credential|apikey|access)[\w-]{0,20}["'\]]?\s*(?:[:=]|=>|\s)\s*["'`]?([A-Za-z0-9+/_-]{24,128}={0,2})(?![A-Za-z0-9+/_=-])/gi,
      (match, token) => {
        if (NOT_SECRET(token) || /^[A-Za-z_-]+$/.test(token) || !/\d/.test(token) || entropy(token) < 4) return match;
        return match.replace(token, note("generic-key", "low", token, where));
      },
    );
    return out;
  }
  return { redact, findings: () => [...findings.values()], samples: () => samples };
}
