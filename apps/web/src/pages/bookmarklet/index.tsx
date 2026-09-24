import "./styles.css";
import React, { useLayoutEffect, useRef, useState } from "react";
import { useSourceUrl } from "../../entities/capabilities/useCapabilities.ts";
import {
  BOOKMARKLET_SOURCE_PATH,
  bookmarkletHref,
} from "../../entities/bookmarklet/index.tsx";
import { CopyText } from "../../shared/ui/CopyText.tsx";
import { onGitHub } from "../../shared/lib/project-links.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";

/**
 * /bookmarklet: the «На Полку» bookmark to drag onto the bookmarks bar. Its
 * address is javascript:, which React refuses in href, so it is set on the
 * element directly after render (and never read from the page's URL).
 */
export function BookmarkletPage() {
  const account = useAccount();
  const sourceUrl = useSourceUrl();
  const href = bookmarkletHref(location.origin);
  const link = useRef<HTMLAnchorElement>(null);
  const [clicked, setClicked] = useState(false);
  useLayoutEffect(() => {
    if (href) link.current?.setAttribute("href", href);
  }, [href]);
  const code = onGitHub(sourceUrl)
    ? `${sourceUrl.replace(/\/$/, "")}/blob/main/${BOOKMARKLET_SOURCE_PATH}`
    : sourceUrl;

  return (
    <AppShell current="bring" account={account} className="bookmarklet-page">
      <main className="bookmarklet-main" id="main">
        <header className="bookmarklet-heading">
          <h1>Закладка «На Полку»</h1>
          <p>
            Сохраняет артефакт из Claude, ChatGPT и других AI-чатов в один клик.
            Без расширения и без разрешений: это обычная закладка.
          </p>
        </header>

        <section className="bookmarklet-drag" aria-labelledby="bookmarklet-drag-title">
          <h2 id="bookmarklet-drag-title">Перетащите кнопку на панель закладок</h2>
          {href ? (
            <a
              ref={link}
              className="bookmarklet-button"
              draggable
              onClick={(event) => {
                event.preventDefault();
                setClicked(true);
              }}
            >
              На Полку
            </a>
          ) : (
            <p role="alert">Не удалось собрать закладку для этого адреса Полки.</p>
          )}
          <p className="bookmarklet-note" role={clicked ? "status" : undefined}>
            {clicked
              ? "Здесь закладка ничего не делает. Перетащите кнопку мышью на панель закладок, а нажимайте на странице чата."
              : "Потом откройте артефакт в чате и нажмите «На Полку» на панели: откроется Полка с готовой карточкой."}
          </p>
        </section>

        <section className="bookmarklet-howto" aria-labelledby="bookmarklet-bar-title">
          <h2 id="bookmarklet-bar-title">Если панели закладок не видно</h2>
          <ul>
            <li>
              <strong>Chrome и Яндекс Браузер:</strong> Ctrl+Shift+B (на Mac ⌘+Shift+B).
            </li>
            <li>
              <strong>Safari:</strong> меню «Вид» → «Показать панель избранного» (⌘+Shift+B).
            </li>
            <li>
              <strong>Firefox:</strong> меню «Вид» → «Панели инструментов» → «Панель закладок».
            </li>
          </ul>
        </section>

        {href && (
          <section className="bookmarklet-howto" aria-labelledby="bookmarklet-copy-title">
            <h2 id="bookmarklet-copy-title">На телефоне или без мыши</h2>
            <p>
              Добавьте в закладки любую страницу, затем измените закладку: имя —
              «На Полку», адрес — этот код целиком.
            </p>
            <CopyText value={href} label="Код закладки" rows={3} buttonLabel="Скопировать код" />
          </section>
        )}

        <section className="bookmarklet-howto" aria-labelledby="bookmarklet-what-title">
          <h2 id="bookmarklet-what-title">Что делает закладка</h2>
          <ul>
            <li>Работает, только когда вы её нажали, и только на странице AI-чата.</li>
            <li>Берёт артефакт со страницы, как расширение: код из меню Download или кнопки Copy, иначе — снимок страницы без скриптов.</li>
            <li>Передаёт его только во вкладку вашей Полки ({location.host}); ничего не отправляет на другие серверы, не читает cookies и ваш буфер обмена.</li>
            <li>
              Код открыт:{" "}
              <a href={code} target="_blank" rel="noopener noreferrer">
                исходник закладки на GitHub
              </a>
              .
            </li>
          </ul>
        </section>
      </main>
    </AppShell>
  );
}
