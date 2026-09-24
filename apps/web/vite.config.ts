import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import {
  ORIGIN_PLACEHOLDER,
  bookmarkletScript,
  javascriptUrl,
} from "../../extensions/bookmarklet/build.ts";

/**
 * virtual:polka-bookmarklet — the «На Полку» bookmark as a javascript:
 * address with a placeholder origin; /bookmarklet puts in its own origin
 * (apps/web/src/entities/bookmarklet). Built from extensions/bookmarklet.
 */
function bookmarklet(): Plugin {
  const id = "virtual:polka-bookmarklet";
  const resolved = `\0${id}`;
  return {
    name: "polka-bookmarklet",
    resolveId: (source) => (source === id ? resolved : null),
    async load(source) {
      if (source !== resolved) return null;
      const href = javascriptUrl(await bookmarkletScript());
      return `export const href = ${JSON.stringify(href)};\nexport const placeholder = ${JSON.stringify(ORIGIN_PLACEHOLDER)};\n`;
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [bookmarklet()],
  build: { outDir: "../../dist", emptyOutDir: true },
  server: { host: "127.0.0.1" },
});
