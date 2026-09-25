import React, { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type {
  AgentScope,
  OAuthConsentDetails,
} from "../../../../../packages/contracts/index.ts";
import { ApiError, client, oauthConsent } from "../../shared/api/client.ts";
import { knownShelf } from "../../shared/lib/known-shelf.ts";
import { visitSource } from "../../shared/lib/visit-source.ts";
import { AskAgentHint } from "../../shared/ui/AskAgentHint.tsx";
import { rememberAccount } from "../../entities/account/model/useAccount.ts";
import { Button, Notice } from "../../shared/ui/controls.tsx";
import { scopeOptions } from "../../entities/agent-scope/scopes.ts";
import { useSignInWays } from "../../entities/capabilities/useCapabilities.ts";
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
  /** No session in this browser: sign in, or start without signing up. */
  | { kind: "guest" }
  | { kind: "ready"; details: OAuthConsentDetails }
  | { kind: "leaving"; host: string; approved: boolean };

const signInHere = () =>
  location.assign(
    `/signup?next=${encodeURIComponent(location.pathname + location.search)}`,
  );

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
  // The shelf the agent works on (docs/specs/TEAM_SHELVES.md): null is one's own.
  const [shelfId, setShelfId] = useState<string | null>(null);
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
          setState({ kind: "guest" });
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
  }, [state.kind]);

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
              scopes: [
                ...new Set<AgentScope>([
                  "context",
                  ...scopes.filter((scope) => fitsRole(chosenRole(state.details, shelfId), scope)),
                ]),
              ],
              ...(shelfId ? { shelfId } : {}),
            }
          : { request: state.details.requestId, decision },
        csrf.csrfToken,
      );
      setState({
        kind: "leaving",
        // «Возвращаем вас …»: a site by its host, an extension by what it is.
        host: state.details.client.extension
          ? "в расширение браузера"
          : `на ${state.details.client.redirectHost}`,
        approved: decision === "approve",
      });
      location.assign(result.redirectTo);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        signInHere();
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
        {state.kind === "guest" && (
          <GuestChoice
            requestId={requestId}
            onStarted={() => setState({ kind: "loading" })}
          />
        )}
        {state.kind === "leaving" && (
          <section className="oauth-card" role="status">
            <span className="eyebrow">Подключение к Полке</span>
            <h1>
              {state.approved ? "Доступ разрешён" : "Подключение отклонено"}
            </h1>
            <p>Возвращаем вас {state.host}…</p>
            {state.approved && (
              <>
                <p>
                  Вернитесь к агенту: теперь он может сохранять работы на вашу
                  полку. Подключение видно в разделе «Агенты».
                </p>
                <AskAgentHint
                  lead="Чтобы вернуться в эту полку из браузера, попросите агента:"
                  tail=""
                />
              </>
            )}
          </section>
        )}
        {state.kind === "ready" && (
          <ConsentForm
            details={state.details}
            accountName={account?.name ?? null}
            scopes={scopes}
            onToggle={toggle}
            shelfId={shelfId}
            onShelf={setShelfId}
            busy={busy}
            error={formError}
            onDecide={(decision) => void decide(decision)}
          />
        )}
      </main>
    </AppShell>
  );
}

/**
 * Where the connector's works will go (docs/specs/SIGN_IN_PROVIDERS.md § 1):
 * the shelf's name and how its owner signs in, so a connector lands in the
 * shelf the person means — with a way out when it is the wrong one.
 */
function ShelfWhere({
  account,
  fallbackName,
  team,
}: {
  account: OAuthConsentDetails["account"];
  fallbackName: string | null;
  /** The department shelf chosen below, if any. */
  team?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const ways = useSignInWays();
  const switchShelf = async () => {
    setBusy(true);
    try {
      await client.logout();
    } finally {
      signInHere();
    }
  };
  if (account?.provisional)
    return (
      <div className="shelf-where">
        <strong>Работы пойдут в вашу полку (временная, этот браузер).</strong>
        <small>
          Делиться ссылками можно будет, когда закрепите полку — войдите{" "}
          {ways.with}. Если 30 дней ею не пользоваться, она удалится.
        </small>
      </div>
    );
  const name = account?.name ?? fallbackName;
  if (!name) return null;
  if (team)
    return (
      <div className="shelf-where">
        <strong>Работы будут сохраняться на полку отдела «{team}»</strong> — их увидят все её
        участники.
      </div>
    );
  return (
    <div className="shelf-where">
      <strong>Работы будут сохраняться в полку «{name}»</strong>
      {account?.methods.length ? ` (${account.methods.join(", ")})` : ""}.
      <small>
        Это не та полка?{" "}
        <button type="button" disabled={busy} onClick={() => void switchShelf()}>
          Выйти и войти в другую
        </button>
      </small>
    </div>
  );
}

/**
 * No session in this browser: «Начать без регистрации» opens a provisional
 * shelf here and connects the agent to it; «Войти» is for an existing shelf.
 * A browser that remembers a shelf is offered that one first.
 */
function GuestChoice({
  requestId,
  onStarted,
}: {
  requestId: string;
  onStarted: () => void;
}) {
  const hint = knownShelf();
  const ways = useSignInWays();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await oauthConsent.startProvisional(requestId, visitSource());
      rememberAccount(await client.session());
      onStarted();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status < 500
          ? e.message
          : "Не удалось открыть полку. Повторите попытку.",
      );
      setBusy(false);
    }
  };
  const signIn = (
    <Button variant={hint ? "primary" : "secondary"} onClick={signInHere} disabled={busy}>
      {hint ? `Войти в полку «${hint.displayName}»` : "Войти в свою полку"}
    </Button>
  );
  const provisional = (
    <Button variant={hint ? "secondary" : "primary"} busy={busy} onClick={() => void start()}>
      Начать без регистрации
    </Button>
  );
  return (
    <section className="oauth-card" aria-labelledby="oauth-guest-title">
      <span className="eyebrow">Подключение к Полке</span>
      <h1 id="oauth-guest-title">Куда агенту сохранять работы?</h1>
      <p className="oauth-lead">
        {hint
          ? `В этом браузере вы входили в полку «${hint.displayName}». Войдите в неё — и агент будет сохранять работы туда.`
          : `Начните без регистрации: полка откроется в этом браузере сразу. Закрепить её (войти ${ways.with}) и делиться ссылками можно потом. Уже есть полка — войдите в неё.`}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="shelf-choice">
        {hint ? (
          <>
            {signIn}
            {provisional}
          </>
        ) : (
          <>
            {provisional}
            {signIn}
          </>
        )}
      </div>
      <AskAgentHint />
    </section>
  );
}

/** A reader on a department shelf connects an agent that only reads. */
const READ_SCOPES: AgentScope[] = ["context", "read", "source:read"];
/** Links and sign-in links belong to one's own shelf for now. */
const OWN_SHELF_SCOPES: AgentScope[] = ["share", "sign_in"];
const fitsRole = (role: string, scope: AgentScope) =>
  (role !== "reader" || READ_SCOPES.includes(scope)) &&
  (role === "owner" || !OWN_SHELF_SCOPES.includes(scope));
const chosenRole = (details: OAuthConsentDetails, shelfId: string | null) =>
  details.shelves?.find((shelf) => shelf.id === shelfId)?.role ?? "owner";
const ROLE_NAME: Record<string, string> = {
  admin: "администратор",
  curator: "куратор",
  author: "автор",
  reader: "читатель",
};

/** Which shelf the agent works on, when the account belongs to a department's. */
function ShelfChoice({
  details,
  shelfId,
  onShelf,
  disabled,
}: {
  details: OAuthConsentDetails;
  shelfId: string | null;
  onShelf: (id: string | null) => void;
  disabled: boolean;
}) {
  const teams = (details.shelves ?? []).filter((shelf) => shelf.name);
  if (!teams.length) return null;
  return (
    <fieldset className="oauth-scopes oauth-shelves">
      <legend>На какой полке будет работать приложение</legend>
      <label className="oauth-scope" data-selected={shelfId === null}>
        <input
          type="radio"
          name="shelf"
          checked={shelfId === null}
          disabled={disabled}
          onChange={() => onShelf(null)}
        />
        <span>
          <strong>Моя полка</strong>
          <small>Работы видите только вы, пока не поделитесь ссылкой.</small>
        </span>
      </label>
      {teams.map((shelf) => (
        <label key={shelf.id} className="oauth-scope" data-selected={shelfId === shelf.id}>
          <input
            type="radio"
            name="shelf"
            checked={shelfId === shelf.id}
            disabled={disabled}
            onChange={() => onShelf(shelf.id)}
          />
          <span>
            <strong>{shelf.name}</strong>
            <small>
              Полка отдела, вы — {ROLE_NAME[shelf.role] ?? shelf.role}. Работы видят все участники.
              {shelf.role === "reader" ? " Приложение сможет только читать и искать." : ""}
            </small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function ConsentForm({
  details,
  accountName,
  scopes,
  onToggle,
  shelfId,
  onShelf,
  busy,
  error,
  onDecide,
}: {
  details: OAuthConsentDetails;
  accountName: string | null;
  scopes: AgentScope[];
  onToggle: (scope: AgentScope) => void;
  shelfId: string | null;
  onShelf: (id: string | null) => void;
  busy: "approve" | "deny" | null;
  error: string | null;
  onDecide: (decision: "approve" | "deny") => void;
}) {
  const role = chosenRole(details, shelfId);
  const offered = scopeOptions.filter(
    (scope) => details.scopes.includes(scope.id) && fitsRole(role, scope.id),
  );
  const extension = details.client.extension;
  return (
    <section className="oauth-card" aria-labelledby="oauth-title">
      <span className="eyebrow">
        {extension?.official
          ? "Расширение браузера «На Полку»"
          : "Подключение к Полке"}
      </span>
      {extension ? (
        <>
          <h1 id="oauth-title">
            Разрешить доступ к вашей полке для{" "}
            <span className="oauth-host">
              {extension.official
                ? "расширения браузера «На Полку»"
                : "расширения браузера"}
            </span>
            ?
          </h1>
          <p className="oauth-lead">
            {extension.official ? (
              <>
                Это официальное расширение Полки. Оно сохраняет артефакты
                Claude и ChatGPT из вашего браузера на вашу полку.
              </>
            ) : (
              <>
                Ответ получит расширение браузера с ID{" "}
                <code className="oauth-extension-id">{extension.id}</code>.
                Оно называет себя «{details.client.name}» — это имя оно указало
                само. Разрешайте, только если вы сами установили это расширение
                и нажали в нём «Подключить».
              </>
            )}
          </p>
        </>
      ) : (
        <>
          <h1 id="oauth-title">
            Разрешить доступ к вашей полке для{" "}
            <span className="oauth-host">{details.client.redirectHost}</span>?
          </h1>
          <p className="oauth-lead">
            Ответ получит сайт <strong>{details.client.redirectHost}</strong>.
            Приложение называет себя «{details.client.name}» — это имя оно
            указало само. Разрешайте, только если вы сами начали подключение на
            этом сайте.
          </p>
        </>
      )}
      <ShelfWhere
        account={details.account}
        fallbackName={accountName}
        team={details.shelves?.find((shelf) => shelf.id === shelfId)?.name}
      />
      <ShelfChoice details={details} shelfId={shelfId} onShelf={onShelf} disabled={busy !== null} />
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
