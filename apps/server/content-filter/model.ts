// The model stage of the content filter (docs/specs/CONTENT_FILTER.md,
// «Модель»). Two models on Yandex AI Studio's OpenAI-compatible endpoint: a
// primary and a second opinion of another family, named only in the
// configuration, with the prompt, JSON schema and text normalisation of the
// benchmark (prompts.ts). The model's `confidence` carries no information
// (the benchmark's primary answers ≥ 0.9 for everything): decisions use the
// category and whether the two models agree.
//
// The stage runs after a save commits and never blocks it
// (content-moderation.ts, reviewRevision). A failed call falls back to the
// second model; when both fail the revision stays «unchecked» and is retried.
import { config } from "../config.ts";
import { CATEGORIES, type Category } from "./lists.ts";
import { CONTENT_CATEGORIES, CONTENT_PROMPT, CONTENT_SCHEMA } from "./prompts.ts";

/** One model's answer. */
export type ModelAnswer =
  | { category: Category | "none"; reason: string; model: string; costRub: number }
  | { failed: "timeout" | "error" | "refusal" | "unparseable" | "budget"; model: string; costRub: number };

export const answered = (
  answer: ModelAnswer | null | undefined,
): answer is Extract<ModelAnswer, { category: unknown }> => !!answer && "category" in answer;

export interface ModelClient {
  readonly name: string;
  classify(input: { text?: string; image?: string }): Promise<ModelAnswer>;
}

const MODEL_CATEGORIES = CONTENT_CATEGORIES;
export const POLICY = CONTENT_PROMPT;
export const RESPONSE_FORMAT = CONTENT_SCHEMA;

/** About 6000 tokens of Russian text. */
export const MAX_TEXT_CHARS = 24_000;

// The benchmark's normalisation, ported as is: spaced letters joined, Latin
// look-alikes in a Cyrillic word read as Cyrillic.
const LAT2CYR: Record<string, string> = {
  a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", y: "у", k: "к", m: "м",
  t: "т", h: "н", b: "в", A: "А", E: "Е", O: "О", P: "Р", C: "С", X: "Х",
  K: "К", M: "М", T: "Т", H: "Н", B: "В",
};
export function normalizeForModel(text: string) {
  const joined = text.replace(
    /(?<![\p{L}\p{N}_])((?:[\p{L}\p{N}_] ){2,}[\p{L}\p{N}_])(?![\p{L}\p{N}_])/gu,
    (match) => match.replaceAll(" ", ""),
  );
  return joined
    .split(" ")
    .map((word) =>
      /[а-яё]/i.test(word) ? [...word].map((ch) => LAT2CYR[ch] ?? ch).join("") : word,
    )
    .join(" ");
}

/** The user message: the text, and its normalised form when it differs. */
export function userMessage(text: string) {
  const cut = text.slice(0, MAX_TEXT_CHARS);
  const normalized = normalizeForModel(cut);
  return `<content>\n${cut}${normalized !== cut ? `\n[нормализовано: ${normalized}]` : ""}\n</content>`;
}

const REFUSAL = /^\s*я не могу обсуждать эту тему/i;

/** A reply as a category, or a reason to fall back. */
export function parseAnswer(
  content: unknown,
  finishReason: unknown,
  model: string,
  costRub: number,
): ModelAnswer {
  if (typeof content !== "string" || !content.trim())
    return { failed: "unparseable", model, costRub };
  if (REFUSAL.test(content)) return { failed: "refusal", model, costRub };
  if (finishReason !== undefined && finishReason !== null && finishReason !== "stop")
    return { failed: "unparseable", model, costRub };
  let parsed: any;
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return { failed: "unparseable", model, costRub };
  }
  const category = String(parsed?.category ?? "");
  if (!(MODEL_CATEGORIES as readonly string[]).includes(category))
    return { failed: "unparseable", model, costRub };
  const ours: Category | "none" =
    category === "safe" ? "none" : category === "fraud_phishing" ? "fraud" : (category as Category);
  if (ours !== "none" && !(CATEGORIES as readonly string[]).includes(ours))
    return { failed: "unparseable", model, costRub };
  return {
    category: ours,
    reason: String(parsed?.reason ?? "")
      .replace(/[\u0000-\u001f]/g, " ")
      .slice(0, 150),
    model,
    costRub,
  };
}

/**
 * CONTENT_MODEL_PRICES_RUB: «<part of a model name>=<input>/<cached input>/<output>»,
 * ₽ per 1000 tokens, comma-separated. A model it does not name counts at
 * the dearest listed price (or 1.2 ₽ each), so the budget errs towards
 * stopping early.
 */
export function parsePrices(value: string) {
  const prices: Array<[string, [number, number, number]]> = [];
  for (const part of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const match = /^([^=]{1,120})=(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(part);
    if (!match) throw new Error(`CONTENT_MODEL_PRICES_RUB: «${part}»`);
    prices.push([match[1]!.trim(), [Number(match[2]), Number(match[3]), Number(match[4])]]);
  }
  return prices;
}

let priceTable: ReturnType<typeof parsePrices> | null = null;
export function costOf(model: string, usage: any) {
  priceTable ??= parsePrices(config.CONTENT_MODEL_PRICES_RUB);
  const dearest = priceTable.reduce(
    (max, [, price]) => Math.max(max, ...price),
    priceTable.length ? 0 : 1.2,
  );
  const [input, cached, output] = priceTable.find(([name]) => model.includes(name))?.[1] ?? [
    dearest,
    dearest,
    dearest,
  ];
  const prompt = Number(usage?.prompt_tokens ?? 0);
  const hit = Number(usage?.prompt_tokens_details?.cached_tokens ?? 0);
  const completion = Number(usage?.completion_tokens ?? 0);
  return ((prompt - hit) * input + hit * cached + completion * output) / 1000;
}

/** Extra request fields of one model (a JSON object from the configuration). */
export function modelOptions(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Model options must be a JSON object");
  return parsed;
}

export function aiStudioClient(options: {
  url: string;
  model: string;
  key: string | null;
  timeoutMs: number;
  /** Model-specific request fields (thinking off, reasoning effort…). */
  extra: Record<string, unknown>;
  maxTokens: number;
  fetch?: typeof fetch;
}): ModelClient {
  const doFetch = options.fetch ?? fetch;
  return {
    name: options.model,
    async classify(input) {
      const content = input.image
        ? [
            { type: "text", text: userMessage("[изображение со страницы пользователя]") },
            { type: "image_url", image_url: { url: input.image } },
          ]
        : userMessage(input.text ?? "");
      try {
        const response = await doFetch(options.url, {
          method: "POST",
          signal: AbortSignal.timeout(options.timeoutMs),
          headers: {
            "content-type": "application/json",
            ...(options.key ? { authorization: `Api-Key ${options.key}` } : {}),
            // Yandex does not log the request.
            "x-data-logging-enabled": "false",
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0,
            max_tokens: options.maxTokens,
            ...options.extra,
            response_format: RESPONSE_FORMAT,
            messages: [
              { role: "system", content: POLICY },
              { role: "user", content },
            ],
          }),
        });
        if (!response.ok) return { failed: "error", model: options.model, costRub: 0 };
        const body: any = await response.json();
        const choice = body?.choices?.[0];
        return parseAnswer(
          choice?.message?.content,
          choice?.finish_reason,
          options.model,
          costOf(options.model, body?.usage),
        );
      } catch (error) {
        const name = (error as Error)?.name;
        return {
          failed: name === "TimeoutError" || name === "AbortError" ? "timeout" : "error",
          model: options.model,
          costRub: 0,
        };
      }
    },
  };
}

export type ModelPair = { primary: ModelClient; fallback: ModelClient | null };

let override: ModelPair | null | undefined;
let configured: ModelPair | null | undefined;

/** The configured models, or null when CONTENT_MODEL_PROVIDER=off. */
export function contentModels(): ModelPair | null {
  if (override !== undefined) return override;
  if (configured !== undefined) return configured;
  if (config.CONTENT_MODEL_PROVIDER === "off" || !config.CONTENT_MODEL_PRIMARY) {
    configured = null;
    return null;
  }
  const url = config.CONTENT_MODEL_URL;
  const key = config.CONTENT_MODEL_API_KEY ?? null;
  configured = {
    primary: aiStudioClient({
      url,
      key,
      model: config.CONTENT_MODEL_PRIMARY,
      timeoutMs: config.CONTENT_MODEL_TIMEOUT_MS,
      extra: modelOptions(config.CONTENT_MODEL_PRIMARY_OPTIONS),
      maxTokens: 200,
    }),
    fallback: config.CONTENT_MODEL_FALLBACK
      ? aiStudioClient({
          url,
          key,
          model: config.CONTENT_MODEL_FALLBACK,
          timeoutMs: config.CONTENT_MODEL_TIMEOUT_MS + 2000,
          extra: modelOptions(config.CONTENT_MODEL_FALLBACK_OPTIONS),
          maxTokens: 400,
        })
      : null,
  };
  return configured;
}

/** Tests put fake models in place (undefined restores the config). */
export function setContentModels(pair: ModelPair | null | undefined) {
  override = pair;
  budget.day = "";
  budget.spent = 0;
  budget.warned = false;
}

// Spend per UTC day, in this process (one app process per installation).
const budget = { day: "", spent: 0, warned: false };

function today() {
  const day = new Date().toISOString().slice(0, 10);
  if (budget.day !== day) {
    budget.day = day;
    budget.spent = 0;
    budget.warned = false;
  }
  return budget;
}

/** False once today's CONTENT_MODEL_DAILY_BUDGET_RUB is spent. */
export const budgetLeft = () => today().spent < config.CONTENT_MODEL_DAILY_BUDGET_RUB;

/** Record a call's cost; true the first time the budget runs out today. */
export function spend(costRub: number) {
  const state = today();
  state.spent += costRub;
  if (state.spent >= config.CONTENT_MODEL_DAILY_BUDGET_RUB && !state.warned) {
    state.warned = true;
    return true;
  }
  return false;
}

export const spentToday = () => today().spent;
