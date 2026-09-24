import React, { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { ApiError, request } from "../../shared/api/client.ts";
import { AppShell } from "../../widgets/navigation/index.tsx";
import { Button, Notice } from "../../shared/ui/controls.tsx";
import { useSignInWays } from "../../entities/capabilities/useCapabilities.ts";
import {
  OPEN_SHELF_PHRASE,
  rememberEnteredByAgent,
  rememberSignInMethod,
} from "../../shared/lib/known-shelf.ts";

type Preview = {
  shelfName: string;
  clientName: string;
  current: { name: string } | null;
};

/**
 * /enter#<token> (docs/specs/SIGN_IN_PROVIDERS.md § 10): a one-time link an
 * agent gave the owner of a provisional shelf. The token sits in the
 * #fragment (no server log, Referer or analytics sees it); the page removes
 * it from the address bar, shows which shelf and which agent, and spends it
 * only on a click — link scanners open pages, they do not press buttons. A
 * browser already signed in is never switched silently.
 */
export function Enter() {
  const ways = useSignInWays();
  const token = useRef("");
  const [state, setState] = useState<
    "busy" | "ready" | "entering" | "stale" | "error"
  >("busy");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    token.current = location.hash.slice(1);
    // Out of the address bar and history before anything else.
    history.replaceState(null, "", "/enter");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token.current)) {
      setState("stale");
      return;
    }
    request<Preview>("/auth/enter/preview", { token: token.current })
      .then((value) => {
        setPreview(value);
        setState("ready");
      })
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 410 || e.status === 400))
          setState("stale");
        else {
          setMessage((e as Error).message);
          setState("error");
        }
      });
  }, []);
  const enter = async () => {
    setState("entering");
    try {
      rememberSignInMethod("agent");
      const { clientName } = await request<{ clientName: string }>(
        "/auth/enter",
        { token: token.current, replace: !!preview?.current },
      );
      rememberEnteredByAgent(clientName);
      location.replace("/");
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) setState("stale");
      else {
        setMessage((e as Error).message);
        setState("error");
      }
    }
  };
  return (
    <AppShell current="shelf" account={null} bare>
      <main className="onboard">
        <div className="onboard-icon">
          <KeyRound />
        </div>
        <span className="eyebrow">Вход по ссылке от агента</span>
        {state === "busy" && (
          <>
            <h1>Проверяем ссылку…</h1>
            <p role="status">Секунду.</p>
          </>
        )}
        {(state === "ready" || state === "entering") && preview && (
          <>
            <h1>Открыть временную полку «{preview.shelfName}»?</h1>
            <p>
              Ссылку дал агент <strong>{preview.clientName}</strong>. Открывайте,
              только если вы сами попросили его об этом. По этой ссылке полку
              можно смотреть; закрепить её, подключить агентов или удалить —
              только после входа {ways.via}.
            </p>
            {preview.current && (
              <Notice>
                Этот браузер уже вошёл в полку «{preview.current.name}».
              </Notice>
            )}
            <div className="shelf-choice">
              <Button
                variant="primary"
                busy={state === "entering"}
                onClick={() => void enter()}
              >
                {preview.current
                  ? `Перейти в «${preview.shelfName}»`
                  : `Открыть «${preview.shelfName}»`}
              </Button>
              {preview.current ? (
                <a className="ui-button ui-button--secondary" href="/">
                  Остаться в «{preview.current.name}»
                </a>
              ) : (
                <a className="ui-button ui-button--secondary" href="/">
                  Не открывать
                </a>
              )}
            </div>
          </>
        )}
        {state === "stale" && (
          <>
            <h1>Ссылка устарела.</h1>
            <p>
              Ссылка для входа действует 5 минут и открывает полку один раз.
              Попросите агента новую: «{OPEN_SHELF_PHRASE}».
            </p>
            <a className="onboard-legacy" href="/signup">
              Войти другим способом
            </a>
          </>
        )}
        {state === "error" && (
          <>
            <h1>Не получилось войти.</h1>
            <Notice tone="error">{message}</Notice>
          </>
        )}
      </main>
    </AppShell>
  );
}
