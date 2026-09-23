// The code reviewer of the model stage (docs/specs/CONTENT_FILTER.md,
// «Вредоносный код»): a compact view of a page's scripts to a model on the
// same OpenAI-compatible endpoint. Its «malicious» blocks only together with
// the rules' malicious_code signals; alone it asks the operator.
import { config } from "../config.ts";
import { costOf, modelOptions } from "./model.ts";
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
  url: string;
  model: string;
  key: string | null;
  timeoutMs: number;
  extra: Record<string, unknown>;
  fetch?: typeof fetch;
}): CodeReviewer {
  const doFetch = options.fetch ?? fetch;
  return {
    name: options.model,
    async review(code) {
      try {
        const response = await doFetch(options.url, {
          method: "POST",
          signal: AbortSignal.timeout(options.timeoutMs),
          headers: {
            "content-type": "application/json",
            ...(options.key ? { authorization: `Api-Key ${options.key}` } : {}),
            "x-data-logging-enabled": "false",
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0,
            max_tokens: 400,
            ...options.extra,
            response_format: CODE_SCHEMA,
            messages: [
              { role: "system", content: CODE_PROMPT },
              { role: "user", content: `<code>\n${code}\n</code>` },
            ],
          }),
        });
        if (!response.ok) return { failed: "error", costRub: 0 };
        const body: any = await response.json();
        return parseCodeReview(
          body?.choices?.[0]?.message?.content,
          costOf(options.model, body?.usage),
        );
      } catch {
        return { failed: "error", costRub: 0 };
      }
    },
  };
}

let override: CodeReviewer | null | undefined;
let configured: CodeReviewer | null | undefined;

export function codeModelClient(): CodeReviewer | null {
  if (override !== undefined) return override;
  if (configured !== undefined) return configured;
  configured =
    config.CONTENT_MODEL_PROVIDER === "off" || !config.CONTENT_CODE_MODEL
      ? null
      : codeReviewer({
          url: config.CONTENT_MODEL_URL,
          model: config.CONTENT_CODE_MODEL,
          key: config.CONTENT_MODEL_API_KEY ?? null,
          timeoutMs: config.CONTENT_MODEL_TIMEOUT_MS + 4000,
          extra: modelOptions(config.CONTENT_CODE_MODEL_OPTIONS),
        });
  return configured;
}

export function setCodeReviewer(reviewer: CodeReviewer | null | undefined) {
  override = reviewer;
}
