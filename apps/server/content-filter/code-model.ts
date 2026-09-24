// The code reviewer of the model stage (docs/specs/CONTENT_FILTER.md,
// «Вредоносный код»): a compact view of a page's scripts to a model on an
// OpenAI-compatible endpoint (CONTENT_CODE_MODEL_*, by default the primary's).
// Its «malicious» blocks only together with the rules' malicious_code
// signals; alone it asks the operator.
import { config, type ModelEndpoint } from "../config.ts";
import { postChat } from "./endpoints.ts";
import { budgetCost, modelOptions } from "./model.ts";
import { CODE_PROMPT, CODE_SCHEMA } from "./prompts.ts";

export type CodeReview =
  | {
      verdict: "safe" | "suspicious" | "malicious";
      category: string;
      reasons: string[];
      costRub: number;
    }
  | { failed: string; costRub: number };

export interface CodeReviewer {
  readonly name: string;
  /** A flat-rate key: the daily budget does not stop its calls. */
  readonly flatRate?: boolean;
  review(code: string): Promise<CodeReview>;
}

export function parseCodeReview(content: unknown, costRub: number): CodeReview {
  if (typeof content !== "string") return { failed: "unparseable", costRub };
  try {
    const start = content.indexOf("{");
    const parsed = JSON.parse(content.slice(start, content.lastIndexOf("}") + 1));
    if (!["safe", "suspicious", "malicious"].includes(parsed?.verdict))
      return { failed: "unparseable", costRub };
    return {
      verdict: parsed.verdict,
      category: String(parsed.category ?? ""),
      reasons: (Array.isArray(parsed.reasons) ? parsed.reasons : [])
        .slice(0, 5)
        .map((reason: unknown) => String(reason).replace(/[\u0000-\u001f]/g, " ").slice(0, 120)),
      costRub,
    };
  } catch {
    return { failed: "unparseable", costRub };
  }
}

export function codeReviewer(options: {
  endpoint: Pick<ModelEndpoint, "provider" | "url" | "key" | "rpm" | "concurrency" | "flatRate">;
  model: string;
  timeoutMs: number;
  extra: Record<string, unknown>;
  fetch?: typeof fetch;
}): CodeReviewer {
  const { endpoint, model } = options;
  return {
    name: model,
    flatRate: endpoint.flatRate,
    async review(code) {
      const result = await postChat(
        endpoint,
        {
          model,
          temperature: 0,
          max_tokens: 400,
          ...options.extra,
          response_format: CODE_SCHEMA,
          messages: [
            { role: "system", content: CODE_PROMPT },
            { role: "user", content: `<code>\n${code}\n</code>` },
          ],
        },
        options.timeoutMs,
        options.fetch,
      );
      if (!result.ok) return { failed: result.failed, costRub: 0 };
      return parseCodeReview(
        result.body?.choices?.[0]?.message?.content,
        budgetCost(endpoint, model, result.body?.usage),
      );
    },
  };
}

let override: CodeReviewer | null | undefined;
let configured: CodeReviewer | null | undefined;

export function codeModelClient(): CodeReviewer | null {
  if (override !== undefined) return override;
  if (configured !== undefined) return configured;
  const endpoint = config.CONTENT_MODEL_ENDPOINTS?.code;
  configured =
    !endpoint || !config.CONTENT_CODE_MODEL
      ? null
      : codeReviewer({
          endpoint,
          model: config.CONTENT_CODE_MODEL,
          timeoutMs: config.CONTENT_MODEL_TIMEOUT_MS + 4000,
          extra: modelOptions(config.CONTENT_CODE_MODEL_OPTIONS),
        });
  return configured;
}

export function setCodeReviewer(reviewer: CodeReviewer | null | undefined) {
  override = reviewer;
}
