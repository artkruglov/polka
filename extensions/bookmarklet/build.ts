/*
 * Builds the «На Полку» bookmarklet: src/main.ts and the extension's readers
 * it imports, bundled by esbuild into one minified IIFE, then written as a
 * javascript: address. Nothing is loaded at run time: a page's CSP would
 * block an external script, so everything is inline.
 *
 * The web build (apps/web/vite.config.ts, virtual:polka-bookmarklet) builds it
 * once with a placeholder address; /bookmarklet puts in the address of the
 * Полка it is served from, so every installation gives out its own bookmark.
 * For a bookmark made by hand:
 *
 *   npx tsx extensions/bookmarklet/build.ts --origin https://polochka.app
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** Stands for the Полка origin until the link is made; plain URL characters. */
export const ORIGIN_PLACEHOLDER = "https://polka-origin.invalid";

export const ENTRY = fileURLToPath(new URL("./src/main.ts", import.meta.url));

/** The minified script, with `origin` (or the placeholder) as Полка's address. */
export async function bookmarkletScript(origin = ORIGIN_PLACEHOLDER): Promise<string> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "iife",
    // Chrome/Yandex 116+, Safari 16.4+, Firefox 115+.
    target: ["chrome116", "safari16", "firefox115"],
    minify: true,
    legalComments: "none",
    charset: "ascii",
    define: { POLKA_ORIGIN: JSON.stringify(checkOrigin(origin)) },
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text.trim();
  return code;
}

/**
 * A javascript: address that survives the URL parser and a trip through the
 * bookmarks bar: %, whitespace (the parser drops tabs and newlines), # and
 * everything outside ASCII (Cyrillic in regular expressions, which esbuild
 * leaves as is) are escaped as UTF-8. Quotes and angle brackets stay: the
 * URL parser keeps them in a javascript: address as they are.
 */
export function javascriptUrl(code: string): string {
  return `javascript:${code.replace(/[%\s#]|[^\x20-\x7e]+/gu, encodeURIComponent)}`;
}

/** Only a bare origin: scheme, host, optional port. */
export function checkOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`Not an origin: ${origin}`);
  }
  if (url.origin !== origin || !/^https?:$/.test(url.protocol))
    throw new Error(`Not an origin: ${origin}`);
  return origin;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf("--origin");
  const origin = at > 0 ? process.argv[at + 1] : undefined;
  if (!origin) {
    console.error("Usage: npx tsx extensions/bookmarklet/build.ts --origin https://polochka.app");
    process.exit(2);
  }
  const href = javascriptUrl(await bookmarkletScript(origin));
  process.stdout.write(`${href}\n`);
  console.error(`На Полку → ${origin}: ${(Buffer.byteLength(href) / 1024).toFixed(1)} KB`);
}
