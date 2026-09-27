import React from "react";
import { LinkButton } from "../../shared/ui/controls.tsx";
import { LegalLinks } from "../../widgets/navigation/index.tsx";
import "./styles.css";

/**
 * Any address the app has no page for. The server answers it with 404 and
 * this shell (apps/server/frontend.ts), so the person sees a page, not JSON.
 */
export function NotFound() {
  return (
    <>
      <main className="not-found-page" id="main">
        <span className="eyebrow">Ошибка 404</span>
        <h1>Страница не найдена</h1>
        <p>
          Такой страницы на Полке нет. Возможно, адрес набран с ошибкой или
          ссылка устарела.
        </p>
        <div className="button-row">
          <LinkButton variant="primary" href="/">
            Моя полка
          </LinkButton>
          <LinkButton href="/landing">О Полке</LinkButton>
        </div>
      </main>
      <LegalLinks />
    </>
  );
}
