import type { Browser } from "playwright-core";
import { PDF_MAX_FILE, PDF_TIMEOUT_MS, type PdfResult } from "../../packages/renderer-contract.ts";
import { withSandboxedPage } from "./snapshot.ts";

/*
 * An accepted version as a PDF (POST /pdf): the whole page in the same
 * sandbox as a shelf cover (snapshot.ts), printed on A4 the way it looks on
 * screen, backgrounds included. Nothing loads from the network, so what the
 * page fetched from elsewhere is missing from the print.
 */
export async function printPage(
  browser: Browser,
  html: string,
  { script = true, timeoutMs = PDF_TIMEOUT_MS }: { script?: boolean; timeoutMs?: number } = {},
): Promise<PdfResult> {
  return withSandboxedPage<PdfResult>(
    browser,
    html,
    { script, timeoutMs, viewport: { width: 1280, height: 800 }, scale: 1 },
    // The whole call is bounded by the sandbox's deadline (page.pdf has no timeout of its own).
    async (page) => {
      await page.emulateMedia({ media: "screen" });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
      });
      if (pdf.length > PDF_MAX_FILE) return { error: "too_large" };
      return { pdf: pdf.toString("base64") };
    },
  );
}
