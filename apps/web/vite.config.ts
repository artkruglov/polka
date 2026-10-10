import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN_PLACEHOLDER, bookmarkletScript, javascriptUrl } from "../../extensions/bookmarklet/build.ts";
import { isAppPage } from "../../packages/contracts/app-routes.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

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

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * `npm run dev:web` (docs/local-development.md): what Vite answers itself —
 * its own modules and the client's sources, the files of apps/web and
 * apps/web/public, and the app's pages (the list the server reads too,
 * packages/contracts/app-routes.ts). Everything else (the API, /mcp, OAuth,
 * /.well-known, /connect, /login, /robots.txt…) goes to the server.
 */
function servedByVite(method: string, url: string) {
  const path = new URL(url, "http://vite").pathname;
  if (/^\/(?:@|__|src\/|node_modules\/)/.test(path)) return true;
  if ((method === "GET" || method === "HEAD") && isAppPage(path)) return true;
  return isFile(join(root, "public", path)) || isFile(join(root, path));
}

/**
 * The proxy to the server on PORT. The server takes a browser's write only
 * from APP_ORIGIN (apps/server/app.ts), so a request from this dev server's
 * own pages has its Origin replaced by APP_ORIGIN; any other Origin passes
 * through unchanged and the server refuses it as before.
 */
function serverProxy(env: Record<string, string>, webOrigin: string): ProxyOptions {
  const server = `http://127.0.0.1:${env.PORT ?? 4390}`;
  const appOrigin = env.APP_ORIGIN ?? server;
  return {
    target: server,
    changeOrigin: true,
    // A redirect to the server's own address comes back to this dev server.
    autoRewrite: true,
    bypass: (req) => (servedByVite(req.method ?? "GET", req.url ?? "/") ? req.url : undefined),
    configure: (proxy) =>
      proxy.on("proxyReq", (proxyReq, req) => {
        if (req.headers.origin === webOrigin) proxyReq.setHeader("origin", appOrigin);
      }),
  };
}

export default defineConfig(({ command, mode }) => {
  // The repository's .env (PORT, APP_ORIGIN, WEB_DEV_PORT) for this config
  // only; nothing from it reaches the client.
  const env = loadEnv(mode, join(root, "../.."), "");
  const port = Number(env.WEB_DEV_PORT ?? Number(env.PORT ?? 4390) + 2);
  return {
    root,
    // React Fast Refresh in the dev server only; the build stays as it was.
    plugins: [bookmarklet(), command === "serve" && react()],
    build: { outDir: "../../dist", emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      proxy: { "/": serverProxy(env, `http://127.0.0.1:${port}`) },
    },
  };
});
