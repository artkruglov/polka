import type { Revision } from "../../../../../packages/contracts/index.ts";

type Shape = Pick<Revision, "mime" | "htmlProfile" | "inlineBuild">;

/**
 * What the reader is looking at, in two words for the agent prompt («похожую
 * интерактивную страницу»). Never the work's title: it can name a person or
 * a company, and the prompt is meant to be pasted into a chat.
 */
export function kindWords(revision: Shape) {
  if (revision.mime === "text/plain") return "похожий текстовый документ";
  if (revision.mime.startsWith("image/")) return "похожее изображение";
  if (revision.mime === "text/html")
    return revision.inlineBuild?.state === "ready" || revision.htmlProfile === "limited"
      ? "похожую интерактивную страницу"
      : "похожую статичную страницу";
  return "похожую страницу";
}

/**
 * The ready prompt behind «Сделать такую же»: a work of the same kind, saved
 * to Полка, and the connection step if the agent has none yet. `ref` marks
 * the sign-ups this prompt leads to (share-remix).
 */
export function remixPrompt(origin: string, revision: Shape, ref = "share-remix") {
  return `Сделай ${kindWords(revision)} и сохрани на Полку. Если Полка не подключена — подключи: ${origin}/connect?ref=${encodeURIComponent(ref)}`;
}
