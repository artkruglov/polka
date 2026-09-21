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
  /** What works in this build. */
  now: string;
  /** What is planned; empty when nothing more is promised. */
  plan: string;
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
      now: "Получатель видит этот же файл.",
      plan: "",
    };
  if (r.htmlProfile === "static")
    return {
      label: "Страница · без скриптов",
      text: "Откроется как сохранённая страница в безопасном просмотре: без скриптов и загрузки из сети.",
      linkable: true,
      badge: "Статичный просмотр",
      now: "Страница открывается целиком: текст, стили и встроенные картинки.",
      plan: "",
    };
  if (r.htmlProfile === "limited")
    return {
      label: "Страница · ограниченный просмотр",
      text: "В статичном просмотре скрипты отключены. Если доступен интерактивный режим, его можно запустить отдельно.",
      linkable: true,
      badge: "Статичный просмотр без скриптов",
      now: "В статичном режиме виден сохранённый вид страницы; элементы управления не выполняют расчёты.",
      plan: "",
    };
  if (r.inlineBuild?.state === "ready")
    return {
      label: "Страница · интерактивный эксперимент",
      text: "Интерактивная версия подготовлена и откроется только после явного запуска.",
      linkable: true,
      badge: "Интерактивная версия готова",
      now: "Интерактивный просмотр запускается вручную.",
      plan: "",
    };
  return {
    label: "Страница · нельзя отправить ссылкой",
    text: "Для этой страницы пока не подготовлен поддерживаемый просмотр. Оригинал сохранён только для вас; ссылку на него создать нельзя.",
    linkable: false,
    badge: "Только для владельца",
    now: "Копия сохранена только для вас; ссылку создать нельзя.",
    plan: "Страницы с формами, паролями и загрузкой из сети не планируется открывать по ссылке без проверки.",
  };
}
