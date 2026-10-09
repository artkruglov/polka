import statics from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isAppPage, isMachinePath } from "../../packages/contracts/app-routes.ts";
import { trackPageView } from "./analytics.ts";
import { config } from "./config.ts";
import { indexable } from "./indexing.ts";

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Link previews (Telegram, Slack, WhatsApp read these). A share link is
// /s#<token>: the fragment never reaches the server or a crawler, so the /s
// card is the same for every link and says nothing about the work. Nothing
// here may depend on the request beyond its path.
const CARDS = {
  share: {
    title: "Полка — вам отправили страницу",
    description: "Страницу сохранили на Полке и поделились ею с вами. Откройте ссылку, чтобы посмотреть.",
    image: "/og/share.png",
    alt: "Полка: вам отправили страницу",
    path: "/s",
  },
  default: {
    title: "Полка — место для работ, сделанных с ИИ",
    description: "Сохраняйте страницы, отчёты и файлы, сделанные с ИИ, и делитесь ими по ссылке.",
    image: "/og/default.png",
    alt: "Полка: место для работ, сделанных с ИИ",
    path: "/",
  },
} as const;

/** Open Graph and Twitter tags for an app page, with absolute URLs. */
export function linkPreviewTags(path: string, origin = config.APP_ORIGIN) {
  const card = path === "/s" ? CARDS.share : CARDS.default;
  const meta = (key: "property" | "name", name: string, content: string) =>
    `<meta ${key}="${name}" content="${escape(content)}" />`;
  return [
    meta("property", "og:type", "website"),
    meta("property", "og:site_name", "Полка"),
    meta("property", "og:locale", "ru_RU"),
    meta("property", "og:title", card.title),
    meta("property", "og:description", card.description),
    meta("property", "og:url", origin + card.path),
    meta("property", "og:image", origin + card.image),
    meta("property", "og:image:type", "image/png"),
    meta("property", "og:image:width", "1200"),
    meta("property", "og:image:height", "630"),
    meta("property", "og:image:alt", card.alt),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:title", card.title),
    meta("name", "twitter:description", card.description),
    meta("name", "twitter:image", origin + card.image),
  ].join("\n  ");
}

/** Cache policy of a built file: hashed bundles forever, fonts for a long time. */
export function staticCacheControl(path: string) {
  if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (path.startsWith("/fonts/")) return "public, max-age=2592000";
  return null;
}

/** Whether a request no route matched is a person opening a page. */
const wantsPage = (method: string, path: string, accept: string | undefined) =>
  (method === "GET" || method === "HEAD") && !isMachinePath(path) && /\btext\/html\b/.test(accept ?? "");

export async function registerFrontend(app: FastifyInstance, root: string) {
  // The app shell with this path's link-preview tags. Read per request: a
  // rebuilt shell may not have existed at boot. Never cached: it names the
  // current hashed bundles.
  const shell = async (path: string, reply: FastifyReply, status = 200) => {
    const html = await readFile(join(root, "index.html"), "utf8");
    return reply
      .code(status)
      .header("cache-control", "no-cache")
      .type("text/html; charset=utf-8")
      .send(
        html.replace(
          "</head>",
          () =>
            `${linkPreviewTags(path)}${indexable(path) && status === 200 ? "" : '\n  <meta name="robots" content="noindex,nofollow" />'}\n  </head>`,
        ),
      );
  };
  // Resolve files at request time: a rebuilt asset may not have existed at boot.
  await app.register(statics, {
    root,
    wildcard: true,
    index: false,
    setHeaders(reply, file) {
      const policy = staticCacheControl("/" + relative(root, file).split(sep).join("/"));
      if (policy) reply.header("cache-control", policy);
    },
  });
  // Otherwise the static handler would answer / with the shell as is.
  // Landing pages count an anonymous visitor's load (analytics.ts).
  app.get("/", (req, reply) => {
    trackPageView(req, "/");
    return shell("/", reply);
  });
  // The pages come from the one list the client router reads too
  // (packages/contracts/app-routes.ts). Any other address a browser opens
  // gets the shell with 404 and the app says «Страница не найдена»; the API
  // and the machine endpoints keep their JSON answer.
  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split("?")[0];
    if (isAppPage(path)) {
      trackPageView(req, path);
      return shell(path, reply);
    }
    if (wantsPage(req.method, path, req.headers.accept)) return shell(path, reply, 404);
    return reply.code(404).send({ code: "not_found", message: "Действие недоступно." });
  });
}
