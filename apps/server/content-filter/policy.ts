// What the content filter does with its findings (docs/specs/CONTENT_FILTER.md,
// «Действия»). Pure: the callers bring the findings and the author's
// standing, and act on the decision inside their own transaction.
import { levelOf, type CategoryHit, type FilterResult, type Level } from "./scanner.ts";
import { CATEGORIES, type Category } from "./lists.ts";

export type FilterMode = "off" | "balanced" | "strict";

/** Rule-only findings a model can overrule for a trusted author (see actionFor). */
const RULES_ONLY_NOTIFY: ReadonlySet<Category> = new Set<Category>(["fraud", "spam"]);
/** Held for review whoever the author is (balanced) or blocked (strict). */
export const SEVERE: ReadonlySet<Category> = new Set([
  "csam",
  "extremism_terror",
  "drugs",
  "weapons_explosives",
  "doxxing",
]);

export const CATEGORY_LABEL: Record<Category | "other", string> = {
  csam: "сексуальное насилие над детьми (CSAM)",
  extremism_terror: "экстремизм и терроризм",
  drugs: "наркотики: сбыт и пропаганда",
  weapons_explosives: "изготовление оружия и взрывчатки",
  doxxing: "списки персональных данных",
  porn: "порнография",
  suicide: "пропаганда суицида",
  gambling: "реклама казино и букмекеров",
  piracy: "пиратство",
  blocklisted_domain: "ссылки на запрещённые сайты",
  fraud: "фишинг",
  spam: "спам",
  vpn: "реклама VPN для обхода блокировок",
  malicious_code: "вредоносный код (майнинг, исполняемые файлы, попытки выхода из песочницы)",
  copyright: "нарушение авторских прав (заявление правообладателя)",
  other: "другое (требование госоргана или решение оператора)",
};

export type Retention = { isolate: boolean; days: number | null };

/**
 * What a block does with the content, per category. isolate: nobody sees it,
 * the owner included; days: deleted that many days after the block (null:
 * not on a schedule). The defaults follow the owner's decision of 24.09.2026;
 * MODERATION_RETENTION overrides them.
 */
export const DEFAULT_RETENTION: Record<Category | "other", Retention> = {
  csam: { isolate: true, days: 90 },
  extremism_terror: { isolate: true, days: 90 },
  drugs: { isolate: true, days: 90 },
  weapons_explosives: { isolate: true, days: 90 },
  doxxing: { isolate: true, days: 30 },
  porn: { isolate: true, days: 30 },
  fraud: { isolate: true, days: 30 },
  // A demand of a prosecutor or Роскомнадзор, or the operator's own block.
  other: { isolate: true, days: 90 },
  // Soft: links closed and the work cannot be linked again, the owner keeps it.
  gambling: { isolate: false, days: null },
  suicide: { isolate: false, days: null },
  vpn: { isolate: false, days: null },
  piracy: { isolate: false, days: null },
  blocklisted_domain: { isolate: false, days: null },
  spam: { isolate: false, days: null },
  malicious_code: { isolate: true, days: 30 },
  // Until the operator resolves the claim; the owner keeps the work (it may
  // be theirs, and the claim may fail).
  copyright: { isolate: false, days: null },
};

export function parseRetention(value: string) {
  const retention = { ...DEFAULT_RETENTION };
  for (const part of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [category, setting] = part.split("=").map((item) => item?.trim());
    if (!category || !(category in retention) || !setting)
      throw new Error(`MODERATION_RETENTION: «${part}»`);
    const key = category as Category | "other";
    if (setting === "keep") retention[key] = { isolate: false, days: null };
    else if (setting === "manual") retention[key] = { isolate: true, days: null };
    else if (/^\d{1,4}$/.test(setting)) retention[key] = { isolate: true, days: Number(setting) };
    else throw new Error(`MODERATION_RETENTION: «${part}»`);
  }
  return retention;
}

/**
 * What the models said about one work (content-moderation.ts stores it in
 * revisions.content_filter.model). agreed: the second model, of another
 * family, named the same category; only then may the answer hide anything.
 */
export type ModelFinding = {
  category: Category;
  agreed: boolean;
  source: "text" | "image" | "code" | "vision";
  reason: string;
};
export type ModelView = {
  /** checked: answers stored; unchecked: every call failed, a retry is queued. */
  state: "none" | "pending" | "checked" | "unchecked";
  findings: ModelFinding[];
};
export const NO_MODEL: ModelView = { state: "none", findings: [] };

export type Standing = { trusted: boolean; operatorCreated: boolean };

export type CategoryFinding = {
  category: Category;
  score: number;
  level: Level;
  /** List terms, or the model's reason; never shown for csam. */
  terms: string[];
  source: "rules" | "model";
  /** A model finding confirmed by the second model. */
  agreed?: boolean;
};

export type ContentAction = "none" | "notify" | "hold" | "block";

export type ContentDecision = {
  action: ContentAction;
  /** The category behind the action. */
  category: Category | null;
  findings: CategoryFinding[];
  /** Disable the author (CSAM, or any block in strict mode). */
  freeze: boolean;
  /** Only spam: the author sees «на проверке», nobody else sees anything. */
  shadow: boolean;
  /** The models have not answered (pending, failed, or out of budget). */
  unchecked: boolean;
};

const RANK: Record<ContentAction, number> = { none: 0, notify: 1, hold: 2, block: 3 };
const LEVEL_RANK: Record<Level, number> = { none: 0, flag: 1, high: 2, block: 3 };

export const NO_DECISION: ContentDecision = {
  action: "none",
  category: null,
  findings: [],
  freeze: false,
  shadow: false,
  unchecked: false,
};

/**
 * The recipient may be told «Полка проверила автоматически»: the models
 * answered (content_filter.model.state is "checked") and neither they nor
 * the rules found anything. Before the answer, without models, after every
 * call failed, or with any finding: false.
 */
export function autoCheckedClean(filter: unknown): boolean {
  const stored = (filter as { model?: { state?: unknown; findings?: unknown } } | null)
    ?.model;
  if (!stored || stored.state !== "checked") return false;
  if (Array.isArray(stored.findings) && stored.findings.length) return false;
  return findingsOf(filter as FilterResult).length === 0;
}

/** Rules findings and model findings of one work, one per source. */
export function findingsOf(
  filter: FilterResult | null | undefined,
  model: ModelView = NO_MODEL,
) {
  const findings: CategoryFinding[] = [];
  for (const [category, hit] of Object.entries(filter?.hits ?? {}) as [
    Category,
    CategoryHit,
  ][]) {
    if (!(CATEGORIES as readonly string[]).includes(category)) continue;
    const level = levelOf(category, hit.score);
    if (level === "none") continue;
    findings.push({ category, score: hit.score, level, terms: hit.terms, source: "rules" });
  }
  for (const finding of model.findings)
    findings.push({
      category: finding.category,
      score: finding.agreed ? 2 : 1,
      // Both models agree: as sure as the rules' high score. One model: a flag.
      level: finding.agreed ? "high" : "flag",
      terms: [`модель (${finding.source}${finding.agreed ? ", подтверждено второй моделью" : ""}): ${finding.reason}`.slice(0, 300)],
      source: "model",
      agreed: finding.agreed,
    });
  return findings;
}

/**
 * The action for one work (or comment) and its author.
 *
 * Always: CSAM at the rules' block score blocks and disables the author;
 * malicious code at its high score (a miner, an executable, several escape
 * attempts) blocks. Any CSAM signal of a model waits, hidden.
 *
 * Models: one model alone never hides anything, it asks the operator (the
 * link keeps working); both models agreeing hold the link, and with
 * CONTENT_FILTER_AUTOBLOCK block a severe category or code the rules flagged
 * too.
 *
 * balanced: a severe category waits whoever the author is; the other
 * categories wait for an author who is not trusted, or for a trusted one (not
 * created by the operator) at the high score, and are otherwise reported.
 *
 * strict (the hosted default, with SHARE_MODERATION=auto): anything flagged
 * waits, whoever the author is; with CONTENT_FILTER_AUTOBLOCK the rules' high
 * score blocks too. Every block disables the author until review.
 *
 * Both modes: fraud that only the rules found in a trusted author's work is
 * reported, not held, once a model reads it and does not call it fraud (the
 * model's answer decides the open link again).
 */
export function decideContent(input: {
  filter: FilterResult | null | undefined;
  model?: ModelView;
  standing: Standing;
  mode: FilterMode;
  autoblock: boolean;
  /** SHARE_MODERATION=off turns the fraud rules off in balanced mode. */
  fraud: boolean;
}): ContentDecision {
  if (input.mode === "off") return NO_DECISION;
  const model = input.model ?? NO_MODEL;
  const findings = findingsOf(input.filter, model).filter(
    (finding) =>
      finding.category !== "fraud" ||
      finding.source === "model" ||
      input.fraud ||
      input.mode === "strict",
  );
  const rulesFound = new Set(
    findings.filter((finding) => finding.source === "rules").map((finding) => finding.category),
  );
  let best: ContentDecision = {
    ...NO_DECISION,
    findings,
    unchecked: model.state === "pending" || model.state === "unchecked",
  };
  let bestFinding: CategoryFinding | null = null;
  // A model reads (or has read) this work and did not put it in this category.
  const modelClears = (category: Category) =>
    model.state !== "none" &&
    !model.findings.some((finding) => finding.category === category);
  for (const finding of findings) {
    const action = actionFor(finding, input, rulesFound, modelClears(finding.category));
    const better =
      !bestFinding ||
      RANK[action] > RANK[best.action] ||
      (RANK[action] === RANK[best.action] &&
        (SEVERE.has(finding.category) && !SEVERE.has(bestFinding.category)
          ? true
          : SEVERE.has(finding.category) === SEVERE.has(bestFinding.category) &&
            LEVEL_RANK[finding.level] > LEVEL_RANK[bestFinding.level]));
    if (better) {
      bestFinding = finding;
      best = {
        ...best,
        action,
        category: finding.category,
        freeze:
          action === "block" &&
          (finding.category === "csam" || input.mode === "strict"),
      };
    }
  }
  best.shadow =
    best.action === "hold" &&
    best.category === "spam" &&
    findings.every((finding) => finding.category === "spam");
  return best;
}

function actionFor(
  finding: CategoryFinding,
  input: { standing: Standing; mode: FilterMode; autoblock: boolean },
  rulesFound: ReadonlySet<Category>,
  modelClearsCategory = false,
): ContentAction {
  const severe = SEVERE.has(finding.category);
  if (finding.source === "model") {
    // A model's CSAM signal: hidden until a person looks, never blocked by it.
    if (finding.category === "csam") return "hold";
    // One model alone: the operator is asked, nothing is hidden.
    if (!finding.agreed) return "notify";
    if (
      input.autoblock &&
      (severe || (finding.category === "malicious_code" && rulesFound.has("malicious_code")))
    )
      return "block";
    // Malicious code both from the rules and the models blocks regardless.
    if (finding.category === "malicious_code" && rulesFound.has("malicious_code"))
      return "block";
    return "hold";
  }
  if (finding.level === "block") return "block";
  // Code harms the recipient whoever wrote it: a miner, an executable or
  // several escape attempts block; fewer signals wait for review.
  if (finding.category === "malicious_code")
    return finding.level === "high" ? "block" : "hold";
  // Phishing or spam found by the rules alone in a trusted author's work,
  // which a model has read without putting it in that category (or will
  // read: its answer decides the open link again and holds it if it
  // confirms). The link works and the operator is told, in either mode. A
  // research page with hundreds of sources, or a product prototype with a
  // sign-in screen, is the owner's ordinary work.
  if (
    RULES_ONLY_NOTIFY.has(finding.category) &&
    input.standing.trusted &&
    modelClearsCategory
  )
    return "notify";
  if (input.mode === "strict") {
    if (input.autoblock && finding.level === "high") return "block";
    return "hold";
  }
  if (severe) return "hold";
  if (!input.standing.trusted) return "hold";
  if (finding.level === "high" && !input.standing.operatorCreated) return "hold";
  return "notify";
}

/** The shares.moderation_reason of a filter decision. */
export const contentReason = (decision: ContentDecision) =>
  decision.category
    ? `${decision.shadow ? "spam" : decision.action === "block" ? "blocked" : "content"}:${decision.category}`
    : "model-unavailable";

/** One line for the operator: categories, scores and terms (none for csam). */
export function describeFindings(findings: readonly CategoryFinding[]) {
  return findings
    .map((finding) => {
      const label = CATEGORY_LABEL[finding.category];
      const score =
        finding.source === "model"
          ? finding.agreed
            ? "обе модели согласны"
            : "одна модель"
          : `счёт ${finding.score}`;
      if (finding.category === "csam") return `${label} (${score})`;
      const terms = finding.terms.length
        ? `: ${finding.terms.map((term) => `«${term}»`).join(", ")}`
        : "";
      return `${label} (${score})${terms}`;
    })
    .join("; ");
}
