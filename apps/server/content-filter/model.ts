// The model stage of the content filter (docs/specs/CONTENT_FILTER.md,
// «Модели»). Two models on OpenAI-compatible endpoints (NeuralDeep, Yandex AI
// Studio or a self-hosted server, each role its own, config.ts): a primary
// and a second opinion of another family, named only in the configuration,
// with the prompt, JSON schema and text normalisation of the benchmark
// (prompts.ts). The model's `confidence` carries no information (the
// benchmark's primary answers ≥ 0.9 for everything): decisions use the
// category and whether the two models agree.
//
// The stage runs after a save commits and never blocks it
// (content-moderation.ts, reviewRevision). A failed or rate-limited call
// falls back to the second model; when both fail the revision stays
// «unchecked» and is retried.
import { config, type ModelEndpoint, type ModelProvider } from "../config.ts";
import { db } from "../db.ts";
import { CATEGORIES, type Category } from "./lists.ts";
import { postChat } from "./endpoints.ts";
import { CONTENT_CATEGORIES, CONTENT_PROMPT, CONTENT_SCHEMA } from "./prompts.ts";

/** One model's answer. rate_limited: a 429 or the endpoint's own limits. */
export type ModelAnswer =
  | { category: Category | "none"; reason: string; model: string; costRub: number }
  | {
      failed: "timeout" | "error" | "refusal" | "unparseable" | "budget" | "rate_limited";
      model: string;
      costRub: number;
    };

export const answered = (
  answer: ModelAnswer | null | undefined,
): answer is Extract<ModelAnswer, { category: unknown }> => !!answer && "category" in answer;

export interface ModelClient {
  readonly name: string;
  /** A flat-rate key: calls cost nothing, so the daily budget does not stop them. */
  readonly flatRate?: boolean;
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

type Price = [input: number, cached: number, output: number];
type PriceEntry = { provider: ModelProvider | null; name: string; price: Price };

/**
 * CONTENT_MODEL_PRICES_RUB: «[<provider>:]<part of a model name>=<input>/<cached
 * input>/<output>», ₽ per 1000 tokens, comma-separated. A provider prefix
 * (neuraldeep:gpt-oss-120b) prices a model only on that provider, since the
 * same model costs differently elsewhere.
 */
export function parsePrices(value: string): PriceEntry[] {
  const prices: PriceEntry[] = [];
  for (const part of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const match = /^([^=]{1,120})=(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(part);
    if (!match) throw new Error(`CONTENT_MODEL_PRICES_RUB: «${part}»`);
    const scoped = /^(yandex|neuraldeep|openai-compatible):(.+)$/.exec(match[1]!.trim());
    prices.push({
      provider: (scoped?.[1] as ModelProvider | undefined) ?? null,
      name: (scoped?.[2] ?? match[1]!).trim(),
      price: [Number(match[2]), Number(match[3]), Number(match[4])],
    });
  }
  return prices;
}

// NeuralDeep's list prices (neuraldeep.ru, 09.2026), ₽ per 1M tokens in/out
// converted to per 1000; a cached input token costs a tenth.
const nd = (input: number, output: number): Price => [input / 1000, input / 10_000, output / 1000];
export const NEURALDEEP_PRICES: PriceEntry[] = [
  ["qwen3.6", nd(7.14, 40.8)],
  ["gemma-4-31b", nd(11, 37.4)],
  ["gpt-oss-120b", nd(5.1, 20.4)],
  ["qwen3.8-27b", nd(24.48, 122.4)],
].map(([name, price]) => ({ provider: "neuraldeep", name: name as string, price: price as Price }));

const longest = (entries: PriceEntry[], model: string) =>
  entries
    .filter((entry) => model.includes(entry.name))
    .sort((a, b) => b.name.length - a.name.length)[0]?.price;
const dearestOf = (entries: PriceEntry[]) =>
  entries.reduce((max, { price }) => Math.max(max, ...price), 0);

let priceTable: PriceEntry[] | null = null;
/**
 * A call's cost in ₽, by the model's name and provider: an entry for that
 * provider, NeuralDeep's list price, an entry for any provider (the longest
 * matching name wins). A model none of them names counts at the dearest
 * price known (1.2 ₽ per 1000 tokens with no table), so the budget errs
 * towards stopping early.
 */
export function costOf(
  model: string,
  usage: any,
  provider: ModelProvider | null = null,
  table: PriceEntry[] = (priceTable ??= parsePrices(config.CONTENT_MODEL_PRICES_RUB)),
) {
  const builtIn = provider === "neuraldeep" ? NEURALDEEP_PRICES : [];
  const known = [...table, ...builtIn];
  const dearest = known.length ? dearestOf(known) : 1.2;
  const [input, cached, output] = longest(
    table.filter((entry) => provider && entry.provider === provider),
    model,
  ) ??
    longest(builtIn, model) ??
    longest(table.filter((entry) => !entry.provider), model) ?? [dearest, dearest, dearest];
  const prompt = Number(usage?.prompt_tokens ?? 0);
  const hit = Number(usage?.prompt_tokens_details?.cached_tokens ?? 0);
  const completion = Number(usage?.completion_tokens ?? 0);
  return ((prompt - hit) * input + hit * cached + completion * output) / 1000;
}

/** The cost that counts towards the budget: none on a flat-rate key. */
export const budgetCost = (
  endpoint: Pick<ModelEndpoint, "provider" | "flatRate">,
  model: string,
  usage: any,
) => (endpoint.flatRate ? 0 : costOf(model, usage, endpoint.provider));

/** Extra request fields of one model (a JSON object from the configuration). */
export function modelOptions(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Model options must be a JSON object");
  return parsed;
}

export function chatModelClient(options: {
  endpoint: Pick<ModelEndpoint, "provider" | "url" | "key" | "rpm" | "concurrency" | "flatRate">;
  model: string;
  timeoutMs: number;
  /** Model-specific request fields (thinking off, reasoning effort…). */
  extra: Record<string, unknown>;
  maxTokens: number;
  fetch?: typeof fetch;
}): ModelClient {
  const { endpoint, model } = options;
  return {
    name: model,
    flatRate: endpoint.flatRate,
    async classify(input) {
      const content = input.image
        ? [
            { type: "text", text: userMessage("[изображение со страницы пользователя]") },
            { type: "image_url", image_url: { url: input.image } },
          ]
        : userMessage(input.text ?? "");
      const result = await postChat(
        endpoint,
        {
          model,
          temperature: 0,
          max_tokens: options.maxTokens,
          ...options.extra,
          response_format: RESPONSE_FORMAT,
          messages: [
            { role: "system", content: POLICY },
            { role: "user", content },
          ],
        },
        options.timeoutMs,
        options.fetch,
      );
      if (!result.ok) return { failed: result.failed, model, costRub: 0 };
      const choice = result.body?.choices?.[0];
      return parseAnswer(
        choice?.message?.content,
        choice?.finish_reason,
        model,
        budgetCost(endpoint, model, result.body?.usage),
      );
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
  const endpoints = config.CONTENT_MODEL_ENDPOINTS;
  if (!endpoints || !config.CONTENT_MODEL_PRIMARY) {
    configured = null;
    return null;
  }
  configured = {
    primary: chatModelClient({
      endpoint: endpoints.primary,
      model: config.CONTENT_MODEL_PRIMARY,
      timeoutMs: config.CONTENT_MODEL_TIMEOUT_MS,
      extra: modelOptions(config.CONTENT_MODEL_PRIMARY_OPTIONS),
      maxTokens: 200,
    }),
    fallback:
      config.CONTENT_MODEL_FALLBACK && endpoints.fallback
        ? chatModelClient({
            endpoint: endpoints.fallback,
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
}

// The day's spend lives in Postgres (login_limits, one row per UTC day), so a
// restart or a deploy does not start the day again from 0 ₽. The day is the
// UTC calendar day: it resets at 00:00 UTC (03:00 in Moscow). `attempts` is
// an integer, so the spend is kept in 1/10000 ₽ (up to about 214 000 ₽ a day;
// larger sums are clamped, which only means «spent»). The row expires at the
// end of its day and maintenance deletes it with the other expired limits.
const UNITS_PER_RUB = 10_000;
const MAX_UNITS = 2_147_483_647;
let clock = () => Date.now();

/** Tests move the budget's clock (undefined restores the real one). */
export function setBudgetClock(now: (() => number) | undefined) {
  clock = now ?? (() => Date.now());
}

function budgetDay() {
  const now = new Date(clock());
  const day = now.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { key: `content-model-budget:${day}`, end };
}

/** Today's spend in rubles (UTC day), read from the database. */
export async function spentToday() {
  const { key } = budgetDay();
  const { rows } = await db.query("SELECT attempts FROM login_limits WHERE key=$1", [key]);
  return (rows[0]?.attempts ?? 0) / UNITS_PER_RUB;
}

/** False once today's CONTENT_MODEL_DAILY_BUDGET_RUB is spent. */
export const budgetLeft = async () =>
  (await spentToday()) < config.CONTENT_MODEL_DAILY_BUDGET_RUB;

/**
 * Record a call's cost (one atomic increment); true for the call that took
 * today's spend to the budget, so the operator is written to once a day.
 */
export async function spend(costRub: number) {
  const units = Math.max(0, Math.min(MAX_UNITS, Math.ceil(costRub * UNITS_PER_RUB)));
  if (!units) return false;
  const { key, end } = budgetDay();
  const {
    rows: [row],
  } = await db.query(
    `INSERT INTO login_limits VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE
       SET attempts=LEAST(login_limits.attempts::bigint+$2,${MAX_UNITS})::int
     RETURNING attempts`,
    [key, units, end],
  );
  const limit = config.CONTENT_MODEL_DAILY_BUDGET_RUB * UNITS_PER_RUB;
  return row.attempts >= limit && row.attempts - units < limit;
}

/** Tests start the day over. */
export async function resetBudget() {
  await db.query("DELETE FROM login_limits WHERE key LIKE 'content-model-budget:%'");
}
