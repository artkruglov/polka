import statics from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { trackPageView } from "./analytics.ts";
import { config } from "./config.ts";
import { indexable } from "./indexing.ts";

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

// Link previews (Telegram, Slack, WhatsApp read these). A share link is
// /s#<token>: the fragment never reaches the server or a crawler, so the /s
// card is the same for every link and says nothing about the work. Nothing
// here may depend on the request beyond its path.
const CARDS = {
  share: {
    title: "Полка — вам отправили страницу",
    description:
      "Страницу сохранили на Полке и поделились ею с вами. Откройте ссылку, чтобы посмотреть.",
    image: "/og/share.png",
    alt: "Полка: вам отправили страницу",
    path: "/s",
  },
  default: {
    title: "Полка — место для работ, сделанных с ИИ",
    description:
      "Сохраняйте страницы, отчёты и файлы, сделанные с ИИ, и делитесь ими по ссылке.",
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

export async function registerFrontend(app: FastifyInstance, root: string) {
  // The app shell with this path's link-preview tags. Read per request: a
  // rebuilt shell may not have existed at boot.
  const shell = async (path: string, reply: FastifyReply) => {
    const html = await readFile(join(root, "index.html"), "utf8");
    return reply
      .type("text/html; charset=utf-8")
      .send(
        html.replace(
          "</head>",
          () =>
            `${linkPreviewTags(path)}${indexable(path) ? "" : '\n  <meta name="robots" content="noindex,nofollow" />'}\n  </head>`,
        ),
      );
  };
  // Resolve files at request time: a rebuilt asset may not have existed at boot.
  await app.register(statics, { root, wildcard: true, index: false });
  // Otherwise the static handler would answer / with the shell as is.
  // Landing pages count an anonymous visitor's load (analytics.ts).
  app.get("/", (req, reply) => {
    trackPageView(req, "/");
    return shell("/", reply);
  });
  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split("?")[0];
    if (
      path === "/s" ||
      path === "/signup" ||
      path === "/signup/choose" ||
      path === "/signup/linked" ||
      path === "/claim" ||
      path === "/enter" ||
      path === "/signin" ||
      path === "/privacy" ||
      path === "/terms" ||
      path === "/pricing" ||
      path === "/enterprise" ||
      path === "/start" ||
      path === "/away" ||
      path === "/mail-off" ||
      path === "/settings/agents" ||
      path === "/bring" ||
      path === "/bring/receive" ||
      path === "/bookmarklet" ||
      path === "/landing" ||
      path === "/connections" ||
      path === "/trash" ||
      path === "/templates" ||
      path === "/library-invite" ||
      path === "/oauth/consent" ||
      path === "/moderation" ||
      /^\/works\/[a-f0-9-]{36}$/.test(path) ||
      /^\/discover(?:\/[a-z0-9-]+)?$/.test(path)
    ) {
      trackPageView(req, path);
      return shell(path, reply);
    }
    return reply
      .code(404)
      .send({ code: "not_found", message: "Действие недоступно." });
  });
}
