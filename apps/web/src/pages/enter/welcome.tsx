// Shared stylesheets this page needs, before its own (cascade order); main.tsx keeps only the global layer.
import "../../shared/ui/onboard.css";
import React, { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { ApiError, request } from "../../shared/api/client.ts";
import { AppShell } from "../../widgets/navigation/index.tsx";
import { Button, Notice } from "../../shared/ui/controls.tsx";

type Preview = {
  shelfName: string;
  email: string | null;
  companyAdmin: boolean;
  current: { name: string } | null;
};

/**
 * /welcome#<token>: a one-time link the server's administrator printed
 * (npm run admin -- account bootstrap, apps/server/operator-sign-in-links.ts),
 * usually for the first administrator of a new installation. Like /enter:
 * the token leaves the address bar first, the page shows whose shelf it
 * opens and spends the link only on a click.
 */
export function Welcome() {
  const token = useRef("");
  const [state, setState] = useState<"busy" | "ready" | "entering" | "stale" | "error">("busy");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    token.current = location.hash.slice(1);
    history.replaceState(null, "", "/welcome");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token.current)) {
      setState("stale");
      return;
    }
    request<Preview>("/auth/welcome/preview", { token: token.current })
      .then((value) => {
        setPreview(value);
        setState("ready");
      })
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 410 || e.status === 400)) setState("stale");
        else {
          setMessage((e as Error).message);
          setState("error");
        }
      });
  }, []);
  const enter = async () => {
    setState("entering");
    try {
      await request("/auth/welcome", { token: token.current, replace: !!preview?.current });
      location.replace(preview?.companyAdmin ? "/settings" : "/");
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
      <main id="main" className="onboard">
        <div className="onboard-icon">
          <KeyRound />
        </div>
        <span className="eyebrow">Вход по ссылке администратора сервера</span>
        {state === "busy" && (
          <>
            <h1>Проверяем ссылку…</h1>
            <p role="status">Секунду.</p>
          </>
        )}
        {(state === "ready" || state === "entering") && preview && (
          <>
            <h1>Войти в полку «{preview.shelfName}»?</h1>
            <p>
              Ссылку выдали на сервере этой Полки{preview.email ? <> для адреса {preview.email}</> : null}. Она
              открывает полку один раз.
              {preview.companyAdmin && " У этого аккаунта есть права администратора компании."} Дальше входите обычным
              способом: кодом на почту или через вход компании с этим адресом.
            </p>
            {preview.current && <Notice>Этот браузер уже вошёл в полку «{preview.current.name}».</Notice>}
            <div className="shelf-choice">
              <Button variant="primary" busy={state === "entering"} onClick={() => void enter()}>
                {preview.current ? `Перейти в «${preview.shelfName}»` : "Войти"}
              </Button>
              <a className="ui-button ui-button--secondary" href="/">
                {preview.current ? `Остаться в «${preview.current.name}»` : "Не входить"}
              </a>
            </div>
          </>
        )}
        {state === "stale" && (
          <>
            <h1>Ссылка устарела.</h1>
            <p>
              Ссылка действует час и открывает полку один раз. Новую выдаёт администратор сервера: npm run admin --
              account bootstrap.
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
