// The tab title per route; undefined: the page sets its own (the workspace,
// /discover). Recipients see a generic title, never the work's: a held or
// blocked link shows nothing about it, and a page may name itself anything.
import { isAppPage } from "../../../../../packages/contracts/app-routes.ts";

export function routeTitle(path: string): string | null | undefined {
  if (!isAppPage(path) && path !== "/dev/components") return "Страница не найдена";
  if (path === "/templates") return "Шаблоны";
  if (path === "/library-invite") return "Приглашение в библиотеку";
  if (path === "/shelf-invite") return "Приглашение на полку отдела";
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
  if (path === "/bot") return "PolkaRenderer — робот Полки";
  if (path === "/pricing") return "Облако, своя установка и тарифы";
  if (path === "/enterprise") return "Для компаний";
  if (path === "/start") return "Первая работа";
  if (path === "/settings") return "Настройки";
  if (path === "/settings/agents" || path === "/connections") return "Агенты";
  if (path === "/settings/company") return "Полки компании";
  if (path === "/sessions") return "Сессии агентов";
  if (path === "/sessions/secrets") return "Секреты в сессиях";
  if (path === "/sessions/usage") return "Расход агентов";
  if (path.startsWith("/sessions/")) return "Сессия агента";
  if (path === "/s") return "Работа по ссылке";
  if (path === "/away") return "Переход по ссылке";
  if (path === "/mail-off") return "Письма о комментариях";
  if (path === "/account-deleted") return "Удаление аккаунта";
  if (path === "/landing") return null;
  if (path === "/bring/receive") return "На Полку";
  if (path === "/bookmarklet") return "Закладка «На Полку»";
  if (path.startsWith("/bring")) return "Сохранить работу";
  return undefined;
}
