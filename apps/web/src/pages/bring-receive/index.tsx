import "./styles.css";
import React, { useState } from "react";
import { CircleAlert } from "lucide-react";
import { nonceFromHash } from "../../../../../packages/contracts/bookmarklet.ts";
import { BOOKMARKLET_PAGE } from "../../entities/bookmarklet/index.tsx";
import {
  FAILURE_TEXT,
  ReceivedCard,
  clearPending,
  loadPending,
  useBookmarkletMessage,
} from "../../features/bookmarklet-receive/index.tsx";
import { LinkButton } from "../../shared/ui/controls.tsx";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";

/**
 * /bring/receive: the tab the «На Полку» bookmark opens. It takes one message
 * from the chat tab that opened it (features/bookmarklet-receive), shows what
 * came and saves it. Opened by hand, it explains the bookmark.
 */
export function BringReceive() {
  const account = useAccount();
  // The nonce is read once and removed from the address bar.
  const [nonce] = useState(() => {
    const value = nonceFromHash(location.hash);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    return value;
  });
  const [pending, setPending] = useState(loadPending);
  const [dismissed, setDismissed] = useState(false);
  const received = useBookmarkletMessage(nonce);
  const source = received.state === "source" ? received.source : pending;
  const dismiss = () => {
    clearPending();
    setPending(null);
    setDismissed(true);
  };

  let body: React.ReactNode;
  if (source && !dismissed) body = <ReceivedCard source={source} onDismiss={dismiss} />;
  else if (nonce && received.state === "waiting" && !dismissed)
    body = (
      <p className="receive-waiting" role="status">
        Ждём данные от закладки…
      </p>
    );
  else if (received.state === "failure" && !dismissed)
    body = (
      <div className="receive-failure" role="alert">
        <CircleAlert aria-hidden="true" />
        <p>{FAILURE_TEXT[received.failure]}</p>
      </div>
    );
  else
    body = (
      <div className="receive-idle">
        <p>
          Сюда закладка «На Полку» передаёт артефакт со страницы Claude, ChatGPT
          или другого AI-чата. Откройте артефакт в чате и нажмите закладку на
          панели закладок — эта страница откроется сама и покажет, что пришло.
        </p>
        <div className="bring-actions">
          <LinkButton variant="primary" href={BOOKMARKLET_PAGE}>
            Установить закладку
          </LinkButton>
          <LinkButton href="/bring">Сохранить файлом или ссылкой</LinkButton>
        </div>
      </div>
    );

  return (
    <AppShell current="bring" account={account} className="bring-page">
      <main className="bring-main receive-main" id="main">
        <header className="bring-heading">
          <h1>На Полку</h1>
          <p>Артефакт со страницы чата — на вашу полку</p>
        </header>
        {body}
      </main>
    </AppShell>
  );
}
