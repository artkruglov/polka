import React, { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { ApiError, request } from "../../shared/api/client.ts";
import { AppShell } from "../../widgets/navigation/index.tsx";
import { Notice } from "../../shared/ui/controls.tsx";
import {
  OPEN_SHELF_PHRASE,
  rememberEnteredByAgent,
  rememberSignInMethod,
} from "../../shared/lib/known-shelf.ts";

/**
 * /enter#<token> (docs/specs/SIGN_IN_PROVIDERS.md § 10): a one-time link an
 * agent handed its owner. The token sits in the #fragment, so no server log,
 * Referer or analytics ever sees it; this page removes it from the address
 * bar, posts it once, and opens the shelf.
 */
export function Enter() {
  const [state, setState] = useState<"busy" | "stale" | "error">("busy");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const token = location.hash.slice(1);
    // Out of the address bar and history before anything else.
    history.replaceState(null, "", "/enter");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setState("stale");
      return;
    }
    rememberSignInMethod("agent");
    request<{ clientName: string }>("/auth/enter", { token })
      .then(({ clientName }) => {
        rememberEnteredByAgent(clientName);
        location.replace("/");
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
  return (
    <AppShell current="shelf" account={null} bare>
      <main className="onboard">
        <div className="onboard-icon">
          <KeyRound />
        </div>
        <span className="eyebrow">Вход по ссылке от агента</span>
        {state === "busy" && (
          <>
            <h1>Открываем полку…</h1>
            <p role="status">Проверяем ссылку.</p>
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
