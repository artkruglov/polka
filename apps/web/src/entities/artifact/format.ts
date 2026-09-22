import type {
  Artifact,
  Revision,
} from "../../../../../packages/contracts/index.ts";
export const date = (s: string) =>
  new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
export const size = (n: number) =>
  n < 1024
    ? `${n} Б`
    : n < 1024 * 1024
      ? `${Math.round(n / 1024)} КБ`
      : `${(n / 1024 / 1024).toFixed(1)} МБ`;
export const status = (a: Artifact) =>
  a.share && ["active", "behind"].includes(a.share.status)
    ? `По ссылке · v${a.share.number}`
    : "Только вы";
export const isImage = (r: Revision) => r.mime.startsWith("image/");
/** Mirrors the server: a lone static HTML entrypoint needs no runtime. */
export const isStaticSingleFileBundle = (r: Revision) =>
  r.storageKind === "bundle" &&
  r.mime === "text/html" &&
  (r.htmlProfile === "static" || r.htmlProfile === "limited") &&
  r.manifest?.files.length === 1 &&
  r.manifest.files[0].path === r.manifest.entrypoint;
export const kindOf = (r: Pick<Revision, "mime">) =>
  r.mime === "text/html"
    ? "Страница"
    : r.mime === "text/plain"
      ? "Текст"
      : "Изображение";
export type ProfileView = {
  label: string;
  text: string;
  linkable: boolean;
  /** Recipient-facing badge for what the link shows today. */
  badge: string;
};
// Describe the saved profile. The separate LivePreview controls determine
// whether an isolated interactive session is available in this deployment.
export function profileView(
  r: Pick<Revision, "mime" | "htmlProfile"> &
    Partial<Pick<Revision, "inlineBuild">>,
): ProfileView {
  if (r.mime !== "text/html")
    return {
      label: kindOf(r),
      text: "Откроется как есть: получатель увидит этот же файл.",
      linkable: true,
      badge: "Файл как есть",
    };
  if (r.htmlProfile === "static")
    return {
      label: "Страница · без скриптов",
      text: "Откроется как сохранённая страница в безопасном просмотре: без скриптов и загрузки из сети.",
      linkable: true,
      badge: "Статичный просмотр",
    };
  if (r.htmlProfile === "limited")
    return {
      label: "Страница · ограниченный просмотр",
      text: "В статичном просмотре скрипты отключены. Если доступен интерактивный режим, его можно запустить отдельно.",
      linkable: true,
      badge: "Статичный просмотр без скриптов",
    };
  if (r.inlineBuild?.state === "ready")
    return {
      label: "Страница · интерактивный эксперимент",
      text: "Интерактивная версия подготовлена и открывается сразу в изолированной песочнице.",
      linkable: true,
      badge: "Интерактивная версия",
    };
  const refused =
    r.inlineBuild?.state === "unsupported" || r.inlineBuild?.state === "failed"
      ? `Интерактивную версию не удалось собрать${r.inlineBuild.reason ? `: ${r.inlineBuild.reason}` : ""}. `
      : "";
  return {
    label: "Страница · нельзя отправить ссылкой",
    text: `${refused || "Для этой страницы пока не подготовлен поддерживаемый просмотр. "}Оригинал сохранён только для вас; ссылку на него создать нельзя.`,
    linkable: false,
    badge: "Только для владельца",
  };
}
export const dateLong = (s: string) =>
  new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
export const dateTime = (s: string) =>
  new Date(s).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
/** Whether an active link exists (a link that is behind still opens). */
export const isLinked = (a: Pick<Artifact, "share">) =>
  !!a.share && ["active", "behind"].includes(a.share.status);
/** Short access label for cards and toolbars. */
export const accessLabel = (a: Pick<Artifact, "share">) =>
  isLinked(a) ? "Доступно по ссылке" : "Только я";
export type Category = "pages" | "documents" | "images" | "other";
export const categoryLabel: Record<Category, string> = {
  pages: "Страницы",
  documents: "Документы",
  images: "Изображения",
  other: "Другое",
};
/** Client-side grouping by what the saved bytes are; the server has no categories. */
export const categoryOf = (r: Pick<Revision, "mime" | "htmlProfile" | "storageKind">): Category =>
  r.mime.startsWith("image/")
    ? "images"
    : r.mime === "text/plain"
      ? "documents"
      : r.mime === "text/html" && r.htmlProfile !== "unsupported"
        ? "pages"
        : "other";
/** A stable hue per material so typographic covers differ without being random. */
export const hueOf = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};
