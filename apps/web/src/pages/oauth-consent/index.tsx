import React, { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type {
  AgentScope,
  OAuthConsentDetails,
} from "../../../../../packages/contracts/index.ts";
import { ApiError, client, oauthConsent } from "../../shared/api/client.ts";
import { Button, Notice } from "../../shared/ui/controls.tsx";
import { scopeOptions } from "../../entities/agent-scope/scopes.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import "./styles.css";

const entryErrors: Record<string, string> = {
  client:
    "Это приложение не зарегистрировано на этой Полке. Удалите коннектор в приложении и добавьте его заново.",
  redirect:
    "Адрес возврата не совпадает с тем, что приложение указало при регистрации. Подключение остановлено.",
  rate: "Слишком много попыток подключения. Повторите через 10 минут.",
  invalid_request:
    "Приложение прислало неполный запрос: Полка требует защиту PKCE (S256). Обновите приложение или коннектор.",
  unsupported_response_type:
    "Приложение запросило неподдерживаемый способ входа. Полка выдаёт доступ только через код авторизации.",
  invalid_target:
    "Приложение запросило доступ к другому адресу. Коннектор должен указывать на адрес /mcp этой Полки.",
  invalid_scope: "Приложение запросило некорректный набор разрешений.",
};

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; details: OAuthConsentDetails }
  | { kind: "leaving"; host: string; approved: boolean };

export function OAuthConsent() {
  const account = useAccount();
  const params = new URLSearchParams(location.search);
  const requestId = params.get("request") ?? "";
  const entryError = params.get("error");
  const [state, setState] = useState<State>(() =>
    entryError
      ? {
          kind: "error",
          message:
            entryErrors[entryError] ??
            "Запрос на подключение некорректен. Начните подключение заново в приложении.",
        }
      : requestId
        ? { kind: "loading" }
        : {
            kind: "error",
            message:
              "Эта страница открывается из Claude, ChatGPT или другого MCP-клиента при подключении Полки.",
          },
  );
  const [scopes, setScopes] = useState<AgentScope[]>([]);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    if (state.kind !== "loading") return;
    const controller = new AbortController();
    oauthConsent
      .details(requestId, controller.signal)
      .then((details) => {
        setScopes(details.defaultScopes);
        setState({ kind: "ready", details });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          location.assign(
            `/signup?next=${encodeURIComponent(location.pathname + location.search)}`,
          );
          return;
        }
        setState({
          kind: "error",
          message:
            error instanceof ApiError && error.status < 500
              ? error.message
              : "Не удалось загрузить запрос. Обновите страницу.",
        });
      });
    return () => controller.abort();
  }, []);

  const decide = async (decision: "approve" | "deny") => {
    if (state.kind !== "ready" || sending.current) return;
    sending.current = true;
    setBusy(decision);
    setFormError(null);
    try {
      const csrf = await client.agentConnections.csrf();
      const result = await oauthConsent.decide(
        decision === "approve"
          ? {
              request: state.details.requestId,
              decision,
              // «Сведения и статус» is shown as always on, so it is always granted.
              scopes: [...new Set<AgentScope>(["context", ...scopes])],
            }
          : { request: state.details.requestId, decision },
        csrf.csrfToken,
      );
      setState({
        kind: "leaving",
        host: state.details.client.redirectHost,
        approved: decision === "approve",
      });
      location.assign(result.redirectTo);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        location.assign(
          `/signup?next=${encodeURIComponent(location.pathname + location.search)}`,
        );
        return;
      }
      setFormError(
        error instanceof ApiError && error.status < 500
          ? error.message
          : "Не удалось сохранить решение. Повторите попытку.",
      );
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const toggle = (scope: AgentScope) =>
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );

  return (
    <AppShell current="connections" account={account}>
      <main className="oauth-consent" id="main">
        {state.kind === "loading" && (
          <p role="status">Загружаем запрос на подключение…</p>
        )}
        {state.kind === "error" && (
          <section className="oauth-card">
            <span className="eyebrow">Подключение к Полке</span>
            <h1>Подключить не получилось</h1>
            <p>{state.message}</p>
          </section>
        )}
        {state.kind === "leaving" && (
          <section className="oauth-card" role="status">
            <span className="eyebrow">Подключение к Полке</span>
            <h1>
              {state.approved ? "Доступ разрешён" : "Подключение отклонено"}
            </h1>
            <p>Возвращаем вас на {state.host}…</p>
            {state.approved && (
              <p>
                Вернитесь к агенту: теперь он может сохранять работы на вашу
                полку. Подключение видно в разделе «Агенты».
              </p>
            )}
          </section>
        )}
        {state.kind === "ready" && (
          <ConsentForm
            details={state.details}
            accountName={account?.name ?? null}
            scopes={scopes}
            onToggle={toggle}
            busy={busy}
            error={formError}
            onDecide={(decision) => void decide(decision)}
          />
        )}
      </main>
    </AppShell>
  );
}

function ConsentForm({
  details,
  accountName,
  scopes,
  onToggle,
  busy,
  error,
  onDecide,
}: {
  details: OAuthConsentDetails;
  accountName: string | null;
  scopes: AgentScope[];
  onToggle: (scope: AgentScope) => void;
  busy: "approve" | "deny" | null;
  error: string | null;
  onDecide: (decision: "approve" | "deny") => void;
}) {
  const offered = scopeOptions.filter((scope) =>
    details.scopes.includes(scope.id),
  );
  return (
    <section className="oauth-card" aria-labelledby="oauth-title">
      <span className="eyebrow">Подключение к Полке</span>
      <h1 id="oauth-title">
        Разрешить доступ к вашей полке для{" "}
        <span className="oauth-host">{details.client.redirectHost}</span>?
      </h1>
      <p className="oauth-lead">
        Ответ получит сайт <strong>{details.client.redirectHost}</strong>.
        Приложение называет себя «{details.client.name}» — это имя оно указало
        само. Разрешайте, только если вы сами начали подключение на этом сайте.
      </p>
      {accountName && (
        <p className="oauth-account">
          Аккаунт: <strong>{accountName}</strong>
        </p>
      )}
      {details.replaces && (
        <Notice>
          У этого приложения уже есть доступ. Новое подключение заменит его,
          прежний доступ закроется.
        </Notice>
      )}
      <fieldset className="oauth-scopes">
        <legend>Что сможет приложение</legend>
        {offered.map((scope) => (
          <label
            key={scope.id}
            className="oauth-scope"
            data-selected={scopes.includes(scope.id)}
          >
            <input
              type="checkbox"
              checked={scope.id === "context" || scopes.includes(scope.id)}
              disabled={scope.id === "context" || busy !== null}
              onChange={() => onToggle(scope.id)}
            />
            <span>
              <strong>{scope.label}</strong>
              <small>
                {scope.id === "context"
                  ? `${scope.description} Нужно всегда.`
                  : scope.description}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="oauth-terms">
        <ShieldCheck size={17} />
        <span>
          Разрешения действуют на всю вашу полку. Приложение получает ключ на{" "}
          {details.accessMinutes} минут и само продлевает его, пока пользуется
          Полкой; если оно не обращается {details.refreshDays} дней, доступ
          закроется, а без повторного подтверждения — не позже чем через год.
          Отозвать доступ можно в любой момент в разделе «Агенты». Уже выданные
          ссылки при отзыве не закрываются — их закрывают на вашей полке.
        </span>
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="oauth-actions">
        <Button
          variant="primary"
          busy={busy === "approve"}
          disabled={busy !== null}
          onClick={() => onDecide("approve")}
        >
          Разрешить
        </Button>
        <Button
          busy={busy === "deny"}
          disabled={busy !== null}
          onClick={() => onDecide("deny")}
        >
          Отклонить
        </Button>
      </div>
    </section>
  );
}
