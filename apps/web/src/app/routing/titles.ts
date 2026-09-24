// The tab title per route; undefined: the page sets its own (the workspace,
// /discover). Recipients see a generic title, never the work's: a held or
// blocked link shows nothing about it, and a page may name itself anything.
export function routeTitle(path: string): string | null | undefined {
  if (path === "/templates") return "Шаблоны";
  if (path === "/library-invite") return "Приглашение в библиотеку";
  if (path === "/oauth/consent") return "Подключение агента";
  if (path === "/moderation") return "Модерация";
  if (path === "/signup") return "Вход";
  if (path === "/signup/choose") return "У вас уже есть полка?";
  if (path === "/signup/linked") return "Способ входа привязан";
  if (path === "/claim") return "Закрепить полку";
  if (path === "/enter") return "Вход по ссылке";
  if (path === "/signin") return "Вход в полку";
  if (path === "/privacy") return "Политика обработки персональных данных";
  if (path === "/terms") return "Пользовательское соглашение";
  if (path === "/pricing") return "Как пользоваться";
  if (path === "/enterprise") return "Для компаний";
  if (path === "/start") return "Первая работа";
  if (path === "/settings/agents" || path === "/connections") return "Агенты";
  if (path === "/s") return "Работа по ссылке";
  if (path === "/away") return "Переход по ссылке";
  if (path === "/mail-off") return "Письма о комментариях";
  if (path === "/landing") return null;
  if (path === "/bring/receive") return "На Полку";
  if (path === "/bookmarklet") return "Закладка «На Полку»";
  if (path.startsWith("/bring")) return "Ссылка, которую легко отправить";
  return undefined;
}
