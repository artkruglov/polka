// A saved version as a PDF for an extension (context.content.pdf,
// docs/specs/EXTENSIONS.md): the page a recipient would see (covers.ts
// renderablePage) goes to the renderer's POST /pdf, signed, and the print
// comes back. Only where the renderer is configured; it keeps nothing.
import type { PdfOutcome } from "../../packages/extension-api/index.ts";
import { PDF_MAX_BODY, PDF_MAX_FILE, type PdfResult } from "../../packages/renderer-contract.ts";
import { config } from "./config.ts";
import { rendererPost, type RendererTarget } from "./cover-snapshot-client.ts";
import { renderablePage } from "./covers.ts";
import { db } from "./db.ts";
import { unavailableSql } from "./revision-availability.ts";
import { rendererUrlAllowed } from "./url-import/renderer-url.ts";

const MAX_ANSWER = Math.ceil(PDF_MAX_FILE * 1.4) + 1024;
const ERRORS = new Set(["timeout", "navigation_failed", "too_large", "busy", "bad_request", "unauthorized"]);

export const pdfConfigured = (base = config.RENDERER_URL, secret = config.RENDERER_SECRET) =>
  !!base && !!secret && rendererUrlAllowed(base);

/** Accepts only the contract's shapes and sizes; anything else is the renderer failing. */
export function parsePdfAnswer(status: number, text: string): PdfResult | { error: "outdated" } {
  // A renderer from before /pdf answers 404 {error: "bad_request"}.
  if (status === 404) return { error: "outdated" };
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`renderer answered HTTP ${status} without JSON`);
  }
  if (value && typeof value.error === "string") {
    if (!ERRORS.has(value.error)) throw new Error("renderer answered an unknown error");
    return { error: value.error };
  }
  if (status !== 200 || typeof value?.pdf !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.pdf))
    throw new Error("renderer answered an unexpected shape");
  const pdf = Buffer.from(value.pdf, "base64");
  if (pdf.length > PDF_MAX_FILE || pdf.subarray(0, 5).toString("latin1") !== "%PDF-")
    throw new Error("renderer answered an unexpected file");
  return { pdf: value.pdf };
}

/** The version's print, or why there is none. Never throws for the page itself. */
export async function pdfForExtension(
  tenantId: string,
  revisionId: string,
  signal?: AbortSignal,
  target: RendererTarget = {},
): Promise<PdfOutcome> {
  const {
    rows: [r],
  } = await db.query(
    `SELECT r.*,${unavailableSql("r")} AS unavailable FROM revisions r
       JOIN artifacts a ON a.id=r.artifact_id AND a.tenant_id=r.tenant_id
      WHERE r.id=$1 AND r.tenant_id=$2 AND a.purged_at IS NULL`,
    [revisionId, tenantId],
  );
  if (!r || r.unavailable) return { skipped: "unavailable" };
  let page: Awaited<ReturnType<typeof renderablePage>>;
  try {
    page = await renderablePage(r, { imageFit: "contain" });
  } catch {
    return { skipped: "failed" };
  }
  if ("reason" in page)
    return {
      skipped: page.reason === "too_large" ? "too_large" : page.reason === "not_visual" ? "not_visual" : "no_source",
    };
  const body = JSON.stringify({ html: page.html, script: page.script });
  if (Buffer.byteLength(body) > PDF_MAX_BODY) return { skipped: "too_large" };
  let answer: PdfResult | { error: "outdated" };
  try {
    const { status, text } = await rendererPost("/pdf", body, MAX_ANSWER, signal, { timeoutMs: 60_000, ...target });
    answer = parsePdfAnswer(status, text);
  } catch {
    return { skipped: "failed" };
  }
  if ("pdf" in answer) return { pdf: Buffer.from(answer.pdf, "base64") };
  return {
    skipped:
      answer.error === "outdated"
        ? "renderer_outdated"
        : answer.error === "busy" || answer.error === "timeout" || answer.error === "too_large"
          ? answer.error
          : "failed",
  };
}
