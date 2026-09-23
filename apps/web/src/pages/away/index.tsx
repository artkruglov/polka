import React, { useEffect, useState } from "react";
import { ApiError, request } from "../../shared/api/client.ts";
import { LinkButton } from "../../shared/ui/controls.tsx";
import { LegalLinks } from "../../widgets/navigation/index.tsx";
import "./styles.css";

type Target = { url: string; host: string };
type State =
  | { kind: "checking" }
  | { kind: "ready"; target: Target }
  | { kind: "refused"; message: string };

const REFUSED =
  "Ссылка устарела или повреждена. Полка открывает внешний адрес только по ссылке из страницы на Полке.";

/**
 * «Вы уходите с Полки»: external links in a user's page lead here. The token
 * in the fragment is checked by the server; this page never navigates on its
 * own, the reader decides with the button.
 */
export function Away() {
  const [state, setState] = useState<State>({ kind: "checking" });
  useEffect(() => {
    const abort = new AbortController();
    const token = location.hash.slice(1);
    if (!token) {
      setState({ kind: "refused", message: REFUSED });
      return;
    }
    request<Target>("/away", { token }, "POST", abort.signal)
      .then((target) => {
        if (abort.signal.aborted) return;
        // The server only signs http(s) addresses; check again before use.
        const url = new URL(target.url);
        if (url.protocol !== "http:" && url.protocol !== "https:")
          throw new Error(REFUSED);
        setState({ kind: "ready", target });
      })
      .catch((e) => {
        if (abort.signal.aborted) return;
        setState({
          kind: "refused",
          message:
            e instanceof ApiError && e.status !== 404 ? e.message : REFUSED,
        });
      });
    return () => abort.abort();
  }, []);
  return (
    <>
      <main className="away-page">
        <span className="eyebrow">Полка</span>
        {state.kind === "checking" && <p role="status">Проверяем ссылку…</p>}
        {state.kind === "refused" && (
          <>
            <h1>Ссылка не открывается</h1>
            <p role="alert">{state.message}</p>
            <LinkButton href="/">На Полку</LinkButton>
          </>
        )}
        {state.kind === "ready" && (
          <>
            <h1>Вы уходите с Полки</h1>
            <p>
              Вы уходите с Полки на <strong>{state.target.host}</strong>. Ссылку
              разместил автор страницы, Полка её не проверяла.
            </p>
            <p className="away-url">{state.target.url}</p>
            <LinkButton
              variant="primary"
              href={state.target.url}
              rel="noopener noreferrer"
            >
              Перейти на {state.target.host}
            </LinkButton>
          </>
        )}
      </main>
      <LegalLinks />
    </>
  );
}
