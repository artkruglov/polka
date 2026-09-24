import {
  Button,
  TextField,
  SelectField,
  Notice,
} from "../../shared/ui/controls.tsx";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { z } from "zod";
import {
  agentScopeSchema,
  type AgentConnection,
  type AgentScope,
} from "../../../../../packages/contracts/index.ts";
import { ApiError, client } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { scopeOptions } from "../../entities/agent-scope/scopes.ts";
import {
  loadIdentities,
  type AccountIdentities,
} from "../../entities/account/model/identities.ts";
import {
  SAVE_PHRASE,
  agentClients,
  clientSetup,
  harvestClient,
  isFreshAccount,
  parseClientId,
  readStoredClient,
  relativeTime,
  signInMethod,
  signInMethodLabel,
  storeClient,
  type AgentClientId,
  type ClientSetup,
  type HarvestClientId,
  type SetupCopy,
} from "../../entities/onboarding/agent-setup.ts";
import { HarvestPrompt } from "../../entities/onboarding/HarvestPrompt.tsx";
import { Tabs } from "../../shared/ui/Tabs.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import { Dialog } from "../../shared/ui/index.tsx";
import { SignInMethods } from "../../features/provider-sign-in/index.tsx";
import { AskAgentHint } from "../../shared/ui/AskAgentHint.tsx";

const clientDefaults = {
  http: "Скрипт (HTTP API)",
  codex: "Codex CLI",
  claude: "Claude Code",
  other: "MCP-клиент",
} as const;
type ClientKind = keyof typeof clientDefaults;
const agentConnectionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  scopes: z.array(agentScopeSchema),
  audience: z
    .string()
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  status: z.enum(["issued", "seen", "expired", "revoked"]),
  kind: z.enum(["token", "oauth"]).default("token"),
  signInLinks: z.boolean().optional(),
  createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  lastSeenAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)))
    .nullable(),
});
const agentConnectionsSchema = z.array(agentConnectionSchema);
const issueResponseSchema = z.object({
  connection: agentConnectionSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** How often the page asks whether the agent has connected, while someone is following the steps. */
export const CONNECTION_POLL_MS = 5000;

export function classifyIssueError(
  error: unknown,
):
  | { kind: "session" }
  | { kind: "form"; message: string }
  | { kind: "ambiguous" } {
  if (error instanceof ApiError && error.status === 401)
    return { kind: "session" };
  if (error instanceof ApiError && error.status >= 400 && error.status < 500)
    return {
      kind: "form",
      message: error.message || "Проверьте данные и повторите попытку.",
    };
  return { kind: "ambiguous" };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatDate(value: string) {
  if (!Number.isFinite(Date.parse(value))) return "дата неизвестна";
  return new Date(value).toLocaleString("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const isActive = (connection: AgentConnection) =>
  connection.status === "issued" || connection.status === "seen";

const scopeLabels = (ids: readonly AgentScope[]) =>
  ids
    .map((id) => scopeOptions.find((scope) => scope.id === id)?.label ?? id)
    .join(" · ");

/** The choice from the address (?client=…), else the remembered one. */
function initialClient(): AgentClientId | null {
  return (
    parseClientId(new URLSearchParams(location.search).get("client")) ??
    readStoredClient()
  );
}

export function AgentConnections() {
  const account = useAccount();
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  // Revoked and expired connections are history: shown on request only.
  const [showInactive, setShowInactive] = useState(false);
  const [listState, setListState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [listError, setListError] = useState<string | null>(null);
  const [identities, setIdentities] = useState<AccountIdentities | null>(null);
  const [selected, setSelected] = useState<AgentClientId | null>(initialClient);
  // The connection that appeared while the steps were open: «Готово!».
  const [arrived, setArrived] = useState<AgentConnection | null>(null);
  // The harvest task's tab: the chosen client until the person switches it.
  const [harvest, setHarvest] = useState<HarvestClientId | null>(null);
  const [devOpen, setDevOpen] = useState(false);
  const [name, setName] = useState("");
  const [clientKind, setClientKind] = useState<ClientKind>("http");
  const [httpExample, setHttpExample] = useState<"cli" | "curl">("cli");
  const [ttlDays, setTtlDays] = useState(7);
  const [scopes, setScopes] = useState<AgentScope[]>(["capture", "context"]);
  const [action, setAction] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [issueNotice, setIssueNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<{
    token: string;
    connection: AgentConnection;
  } | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<AgentConnection | null>(
    null,
  );
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const listAbort = useRef<AbortController | null>(null);
  const actionAbort = useRef<AbortController | null>(null);
  const actionRef = useRef<string | null>(null);
  const mounted = useRef(true);
  // Active connections already seen: anything beyond them is the new one.
  const known = useRef<Set<string> | null>(null);

  const goToLogin = useCallback(() => {
    actionAbort.current?.abort();
    actionRef.current = null;
    setAction(null);
    setSecret(null);
    setShowSecret(false);
    const next = `${location.pathname}${location.search}${location.hash}`;
    location.assign(`/signup?next=${encodeURIComponent(next)}`);
  }, []);

  /** `silent`: a background poll keeps the list on screen instead of «Загружаем…». */
  const refresh = useCallback(
    async (silent = false) => {
      listAbort.current?.abort();
      const controller = new AbortController();
      listAbort.current = controller;
      if (!silent) {
        setListState("loading");
        setListError(null);
      }
      try {
        const result = agentConnectionsSchema.parse(
          await client.agentConnections.list(controller.signal),
        );
        if (!mounted.current || controller.signal.aborted) return;
        setConnections(result);
        setListState("ready");
        const active = result.filter(isActive);
        if (known.current) {
          const fresh = active.find((item) => !known.current!.has(item.id));
          if (fresh) setArrived(fresh);
        }
        known.current = new Set(active.map((item) => item.id));
      } catch (error) {
        if (!mounted.current || controller.signal.aborted) return;
        if (classifyIssueError(error).kind === "session") {
          goToLogin();
          return;
        }
        if (silent) return;
        // Any other failure ends loading: the list shows the reason and a retry.
        setListState("error");
        setListError(
          error instanceof ApiError && error.status >= 400 && error.status < 500
            ? error.message
            : "Не удалось загрузить подключения. Повторите попытку.",
        );
      } finally {
        if (listAbort.current === controller) listAbort.current = null;
      }
    },
    [goToLogin],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      listAbort.current?.abort();
      actionAbort.current?.abort();
      setSecret(null);
    };
  }, [refresh]);

  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    loadIdentities(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setIdentities(data);
      })
      .catch(() => {
        // The strip then says only who is signed in; «Способы входа» below reports the failure.
      });
    return () => controller.abort();
  }, [account]);

  // While the steps are open and the tab is visible, ask every few seconds
  // whether the agent has connected; stop once it has.
  useEffect(() => {
    if (!selected || arrived || listState === "error") return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const timer = setInterval(tick, CONNECTION_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [selected, arrived, listState, refresh]);

  const choose = (id: AgentClientId) => {
    const next = selected === id ? null : id;
    setSelected(next);
    setArrived(null);
    storeClient(next);
    const url = new URL(location.href);
    if (next) url.searchParams.set("client", next);
    else url.searchParams.delete("client");
    history.replaceState(history.state, "", url);
  };

  const setBusy = (value: string | null) => {
    actionRef.current = value;
    setAction(value);
  };

  const toggleScope = (scope: AgentScope) => {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  };

  const issue = async (event: React.FormEvent) => {
    event.preventDefault();
    if (actionRef.current || listState !== "ready") return;
    const cleanName = name.trim();
    if (cleanName.length < 1 || cleanName.length > 80) {
      setFormError("Введите имя подключения от 1 до 80 символов.");
      return;
    }
    if (!scopes.includes("context")) {
      setFormError("Сведения и статус нужны каждому подключению.");
      return;
    }
    setFormError(null);
    setIssueNotice(null);
    setBusy("issue");
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      const csrf = await client.agentConnections.csrf(controller.signal);
      const audience = new URL("/mcp", location.origin).href;
      const result = issueResponseSchema.parse(
        await client.agentConnections.issue(
          { name: cleanName, scopes, audience, ttlDays },
          csrf.csrfToken,
          controller.signal,
        ),
      );
      if (!mounted.current || controller.signal.aborted) return;
      setShowSecret(false);
      setSecret(result);
      setDevOpen(true);
      // A token the person made themselves is not the agent arriving.
      known.current?.add(result.connection.id);
      await refresh();
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        goToLogin();
        return;
      }
      setIssueNotice(
        "Подключение могло быть создано, но токен не получен. Проверьте список; ненужную запись можно отозвать.",
      );
      await refresh();
    } finally {
      if (actionAbort.current === controller) actionAbort.current = null;
      if (actionRef.current === "issue") setBusy(null);
    }
  };

  /** «Может выдавать ссылки для входа»: the owner's switch per OAuth connection. */
  const toggleSignInLinks = async (connection: AgentConnection) => {
    if (actionRef.current) return;
    setBusy(`links:${connection.id}`);
    setRevokeError(null);
    try {
      const csrf = await client.agentConnections.csrf();
      await client.agentConnections.setSignInLinks(
        connection.id,
        !connection.signInLinks,
        csrf.csrfToken,
      );
      if (mounted.current) void refresh();
    } catch (error) {
      if (!mounted.current) return;
      setRevokeError(
        error instanceof ApiError && error.status < 500
          ? error.message
          : "Не удалось сохранить. Повторите попытку.",
      );
    } finally {
      if (actionRef.current === `links:${connection.id}`) setBusy(null);
    }
  };

  /** Resolves true once access is revoked; the confirmation stays open on failure. */
  const revoke = async (connection: AgentConnection) => {
    if (actionRef.current) return false;
    setBusy(`revoke:${connection.id}`);
    setRevokeError(null);
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      const csrf = await client.agentConnections.csrf(controller.signal);
      await client.agentConnections.revoke(
        connection.id,
        csrf.csrfToken,
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted) return false;
      if (secret?.connection.id === connection.id) setSecret(null);
      if (arrived?.id === connection.id) setArrived(null);
      void refresh();
      return true;
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return false;
      if (error instanceof ApiError && error.status === 401) {
        goToLogin();
        return false;
      }
      setRevokeError(
        error instanceof ApiError && error.status >= 400 && error.status < 500
          ? error.message
          : "Не удалось отозвать доступ. Повторите попытку.",
      );
      return false;
    } finally {
      if (actionAbort.current === controller) actionAbort.current = null;
      if (actionRef.current === `revoke:${connection.id}`) setBusy(null);
    }
  };

  const endpoint =
    secret?.connection.audience ?? new URL("/mcp", location.origin).href;
  const tokenVariable =
    clientKind === "http" ? "POLKA_TOKEN" : "POLKA_MCP_TOKEN";
  // Placeholders only: the token itself never appears in a snippet.
  const cliCommands = useMemo(
    () =>
      [
        `curl -fsSLo polka-publish.mjs ${shellQuote(`${location.origin}/api/v1/cli/polka-publish.mjs`)}`,
        "read -r -s POLKA_TOKEN && export POLKA_TOKEN",
        'node polka-publish.mjs report.html --title "Отчёт" --share 7',
      ].join("\n"),
    [],
  );
  const curlCommand = useMemo(
    () =>
      [
        'jq -n --rawfile html report.html --arg title "Отчёт" --arg key "$(uuidgen)" \\',
        "  '{key: $key, title: $title, html: $html, expiresInDays: 7}' |",
        `  curl -sS ${shellQuote(`${location.origin}/api/v1/publish`)} \\`,
        '    -H "Authorization: Bearer $POLKA_TOKEN" \\',
        '    -H "Content-Type: application/json" --data-binary @-',
      ].join("\n"),
    [],
  );
  const codexCommand = useMemo(
    () =>
      `read -r -s POLKA_MCP_TOKEN\nexport POLKA_MCP_TOKEN\ncodex mcp add polka --url ${shellQuote(endpoint)} --bearer-token-env-var POLKA_MCP_TOKEN`,
    [endpoint],
  );
  const claudeConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            polka: {
              type: "http",
              url: endpoint,
              headers: { Authorization: "Bearer ${POLKA_MCP_TOKEN}" },
            },
          },
        },
        null,
        2,
      ),
    [endpoint],
  );

  const setup = selected ? clientSetup(location.origin, selected) : null;
  const active = connections.filter(isActive);
  const method = identities
    ? signInMethod(identities.identities, identities.email)
    : null;

  return (
    <AppShell
      current="connections"
      account={account}
      className="agent-connections-page"
    >
      <main className="agent-connections" id="main">
        <header className="agent-page-heading">
          <h1>Подключите ИИ к Полке</h1>
          <p className="agent-lead">
            Агент будет сохранять ваши работы на эту полку и давать ссылки на
            них. Вы разрешаете это один раз, в браузере.
          </p>
          {account && (
            <div className="agent-account" role="note">
              <p>
                Вы вошли как <strong>{account.name}</strong>
                {identities?.email && identities.email !== account.name
                  ? ` (${identities.email})`
                  : ""}
                {method ? ` ${signInMethodLabel(method)}` : ""}.
              </p>
              {isFreshAccount(account.createdAt) && (
                <p className="agent-account-fresh">
                  Эта полка создана только что. Уже есть другая полка?{" "}
                  {method?.kind === "provider" ? (
                    <>
                      Отвяжите {method.name} в{" "}
                      <a href="#sign-in">«Способах входа»</a>, войдите в ту
                      полку и привяжите {method.name} там — тогда это будет одна
                      полка.
                    </>
                  ) : (
                    <>
                      Войдите в неё и привяжите Яндекс ID или VK ID в{" "}
                      <a href="#sign-in">«Способах входа»</a> — тогда это будет
                      одна полка.
                    </>
                  )}
                </p>
              )}
            </div>
          )}
        </header>

        <section
          className="agent-status"
          data-state={
            arrived ? "arrived" : active.length ? "connected" : "none"
          }
          aria-labelledby="agent-status-title"
          aria-live="polite"
        >
          <h2 id="agent-status-title" className="sr-only">
            Состояние подключения
          </h2>
          {arrived ? (
            <div className="agent-status-arrived">
              <Check aria-hidden="true" />
              <div>
                <strong>Готово! {arrived.name} подключён.</strong>
                <p>
                  Попросите агента: «{SAVE_PHRASE}». Работа появится на вашей
                  полке.
                </p>
              </div>
              <CopyButton
                value={SAVE_PHRASE}
                label="Скопировать фразу"
                successText="Фраза скопирована"
              />
            </div>
          ) : listState === "loading" && !connections.length ? (
            <p role="status">Проверяем подключения…</p>
          ) : listState === "error" ? (
            <div className="agent-error" role="alert">
              <p>{listError}</p>
              <Button type="button" onClick={() => void refresh()}>
                Повторить
              </Button>
            </div>
          ) : active.length ? (
            <ul className="agent-status-list">
              {active.map((connection) => (
                <li key={connection.id}>
                  <span className="agent-status-dot" aria-hidden="true" />
                  <span>
                    <strong>Подключено: {connection.name}</strong>
                    {connection.kind === "token" ? " (токен)" : ""} ·{" "}
                    {connection.lastSeenAt
                      ? `последний раз ${relativeTime(connection.lastSeenAt)}`
                      : "запросов ещё не было"}
                  </span>
                </li>
              ))}
              {active.some((connection) => connection.kind === "oauth") && (
                <li className="agent-status-hint">
                  <AskAgentHint
                    lead="Чтобы открыть эту полку в другом браузере, попросите агента:"
                    tail="— он даст ссылку для входа."
                  />
                </li>
              )}
            </ul>
          ) : (
            <p className="agent-status-none">
              <strong>Пока ничего не подключено</strong> — выберите, где вы
              работаете с ИИ.
            </p>
          )}
        </section>

        {(arrived || active.length > 0) && listState !== "error" && (
          <NextStep
            client={harvest ?? harvestClient(selected)}
            onClient={setHarvest}
          />
        )}

        <section className="agent-where" aria-labelledby="agent-where-title">
          <h2 id="agent-where-title">Где вы работаете с ИИ?</h2>
          <div
            className="agent-client-cards"
            role="group"
            aria-label="Где вы работаете с ИИ"
          >
            {agentClients.map((item) => (
              <button
                key={item.id}
                type="button"
                className="agent-client-card"
                aria-pressed={selected === item.id}
                onClick={() => choose(item.id)}
              >
                <strong>{item.name}</strong>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>
          {setup && (
            <SetupPanel
              setup={setup}
              waiting={!arrived && listState !== "error"}
            />
          )}
        </section>

        <details
          className="agent-card agent-developers"
          open={devOpen}
          onToggle={(event) => setDevOpen(event.currentTarget.open)}
        >
          <summary>
            <span>Для разработчиков: токены, HTTP API и CLI</span>
          </summary>
          <div className="agent-developers-body">
            <p className="agent-help">
              Токен — ключ для программ, которые не умеют входить через браузер:
              скрипты, CI, свои агенты. Для ChatGPT, Claude, Codex и Claude Code
              он не нужен — они входят сами, как описано выше.
            </p>
            <h3 id="new-agent-title">Создать токен</h3>
            <form onSubmit={issue} aria-labelledby="new-agent-title">
              <TextField
                label="Имя подключения"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                placeholder="Например, ночной отчёт"
                required
              />
              <fieldset>
                <legend>Для чего</legend>
                <div className="agent-choice-row">
                  {(
                    [
                      ["http", "Скрипт или HTTP API"],
                      ["codex", "Codex CLI по токену"],
                      ["claude", "Claude Code по токену"],
                      ["other", "Другой MCP-клиент по токену"],
                    ] as const
                  ).map(([id, label]) => (
                    <label
                      key={id}
                      className="agent-choice"
                      data-selected={clientKind === id}
                    >
                      <input
                        type="radio"
                        name="agent-client"
                        checked={clientKind === id}
                        onChange={() => {
                          setClientKind(id);
                          if (!name.trim()) setName(clientDefaults[id]);
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <SelectField
                label="Срок действия"
                value={ttlDays}
                onChange={(event) => setTtlDays(Number(event.target.value))}
              >
                <option value={1}>1 день</option>
                <option value={7}>7 дней</option>
                <option value={30}>30 дней</option>
              </SelectField>
              <fieldset>
                <legend>Разрешения</legend>
                <p className="agent-help">
                  Разрешения действуют на всю вашу полку, а не на одну папку.
                  Чтение списка и каждое действие включаются отдельно.
                </p>
                {clientKind === "http" && !scopes.includes("share") && (
                  <p className="agent-help">
                    Чтобы API сразу возвращал ссылку, включите «
                    {scopeOptions.find((scope) => scope.id === "share")?.label}
                    ». Без этого работа сохранится только для вас.
                  </p>
                )}
                <div className="agent-scopes">
                  {scopeOptions.filter((scope) => !scope.oauthOnly).map((scope) => (
                    <label
                      key={scope.id}
                      className="agent-scope"
                      data-selected={scopes.includes(scope.id)}
                    >
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope.id)}
                        onChange={() => toggleScope(scope.id)}
                        disabled={scope.id === "context"}
                      />
                      <span>
                        <strong>{scope.label}</strong>
                        <small>{scope.description}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {formError && <Notice tone="error">{formError}</Notice>}
              {issueNotice && <Notice>{issueNotice}</Notice>}
              <Button
                variant="primary"
                type="submit"
                disabled={listState !== "ready" || action !== null}
              >
                {action === "issue" ? "Создаём…" : "Создать токен"}
              </Button>
            </form>

            {secret && (
              <section
                className="agent-card agent-secret"
                aria-labelledby="agent-secret-title"
              >
                <div className="agent-card-heading">
                  <div>
                    <h3 id="agent-secret-title">Токен подключения</h3>
                    <p>
                      Токен показывается только сейчас. После закрытия получить
                      его повторно нельзя; можно отозвать подключение и создать
                      новое.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="quiet"
                    className="icon"
                    aria-label="Закрыть токен"
                    onClick={() => {
                      setSecret(null);
                      setShowSecret(false);
                    }}
                  >
                    <X />
                  </Button>
                </div>
                <label className="agent-field">
                  <span>Секрет</span>
                  <div className="agent-secret-row">
                    <input
                      type={showSecret ? "text" : "password"}
                      value={secret.token}
                      readOnly
                      aria-label="Токен подключения"
                    />
                    <Button
                      type="button"
                      onClick={() => setShowSecret((value) => !value)}
                    >
                      {showSecret ? "Скрыть" : "Показать"}
                    </Button>
                  </div>
                </label>
                <CopyButton
                  value={secret.token}
                  label="Скопировать токен"
                  successText="Токен скопирован"
                />
                <dl className="agent-details">
                  <div>
                    <dt>Endpoint</dt>
                    <dd>
                      <code>{endpoint}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Разрешения</dt>
                    <dd>{scopeLabels(secret.connection.scopes)}</dd>
                  </div>
                  <div>
                    <dt>Истекает</dt>
                    <dd>{formatDate(secret.connection.expiresAt)}</dd>
                  </div>
                </dl>
                <h4>Настройка клиента</h4>
                <p className="agent-help">
                  Переменная должна быть доступна процессу клиента. Не
                  вставляйте токен в чат.
                </p>
                {clientKind === "codex" && (
                  <InstructionBlock title="Codex CLI" value={codexCommand} />
                )}
                {clientKind === "claude" && (
                  <InstructionBlock
                    title="Claude Code — добавьте в существующий .mcp.json"
                    value={claudeConfig}
                  />
                )}
                {clientKind === "http" && (
                  <p className="agent-instruction">
                    Команды для публикации — в блоке «HTTP API и CLI» ниже: CLI
                    и API читают токен из переменной <code>POLKA_TOKEN</code>.
                  </p>
                )}
                {clientKind === "other" && (
                  <p className="agent-instruction">
                    Используйте Streamable HTTP endpoint и Authorization Bearer
                    из секрета. Совместимость конкретного клиента проверьте в
                    его документации.
                  </p>
                )}
                <p className="agent-instruction">
                  <code>read -r -s {tokenVariable}</code>, затем вставьте токен
                  и нажмите Enter; после этого выполните{" "}
                  <code>export {tokenVariable}</code>.{" "}
                  {clientKind === "http"
                    ? "Скрипт запускается из этого же терминала; на сервере положите токен в хранилище секретов."
                    : "Клиент запускается из этого же терминала."}
                </p>
                <p className="agent-next-step">
                  {clientKind === "http" ? (
                    <>
                      Опубликуйте файл командой ниже — подключение появится в
                      списке как использованное.
                    </>
                  ) : (
                    <>
                      Попросите клиента вызвать <code>polka_context</code> —
                      подключение появится в списке как использованное.
                    </>
                  )}
                </p>
              </section>
            )}

            <section className="agent-http" aria-labelledby="agent-http-title">
              <h3 id="agent-http-title">HTTP API и CLI</h3>
              <p className="agent-help">
                Для внутренних агентов, CI и скриптов без MCP: один запрос{" "}
                <code>POST /api/v1/publish</code> сохраняет HTML-страницу и,
                если подключению разрешено управлять ссылками, возвращает
                ссылку. Нужен токен с разрешением «
                {scopeOptions.find((scope) => scope.id === "capture")?.label}» —
                токен создаётся выше в этом разделе. Токен — только в заголовке
                Authorization и переменной окружения, не в аргументах и не в
                чате.
              </p>
              <Tabs
                label="Пример"
                value={httpExample}
                onChange={setHttpExample}
                items={[
                  { id: "cli", label: "CLI (Node 22+)" },
                  { id: "curl", label: "curl" },
                ]}
              >
                {httpExample === "cli" ? (
                  <InstructionBlock
                    title="Скачать CLI и опубликовать файл"
                    value={cliCommands}
                    copyLabel="Скопировать команды"
                    copiedLabel="Команды скопированы"
                  />
                ) : (
                  <InstructionBlock
                    title="Один запрос: jq собирает JSON, curl отправляет"
                    value={curlCommand}
                    copyLabel="Скопировать команду"
                    copiedLabel="Команда скопирована"
                  />
                )}
              </Tabs>
              <p className="agent-instruction">
                Ответ: <code>url</code> — ссылка для отправки,{" "}
                <code>shelfUrl</code> — работа на вашей полке. Повтор с тем же{" "}
                <code>key</code> возвращает ту же ссылку. Лимит: 5 МБ на
                страницу, 120 запросов за 10 минут на подключение.
              </p>
            </section>
          </div>
        </details>

        <section
          className="agent-card agent-existing"
          aria-labelledby="agent-list-title"
        >
          <div className="agent-card-heading">
            <div>
              <h2 id="agent-list-title">Подключения</h2>
              <p>
                Кто может обращаться к вашей полке. Запрос от агента ещё не
                означает, что работа сохранена: результат виден на полке.
              </p>
            </div>
            <Button
              type="button"
              onClick={() => void refresh()}
              disabled={listState === "loading"}
            >
              <RefreshCw size={16} /> Обновить
            </Button>
          </div>
          {listState === "loading" && !connections.length && (
            <p role="status">Загружаем подключения…</p>
          )}
          {listState === "error" && (
            <div className="agent-error" role="alert">
              <p>{listError}</p>
              <Button type="button" onClick={() => void refresh()}>
                Повторить
              </Button>
            </div>
          )}
          {listState === "ready" &&
            !connections.some((connection) => isActive(connection)) && (
              <div className="agent-empty">
                <strong>Подключений нет</strong>
                Ни один агент ещё не получал доступ к этой полке. Выберите выше,
                где вы работаете с ИИ, — подключение появится здесь.
              </div>
            )}
          {connections.length > 0 && (
            <div className="agent-list">
              {connections
                .filter((connection) => showInactive || isActive(connection))
                .map((connection) => (
                  <article
                    className="agent-list-item"
                    key={connection.id}
                    data-active={isActive(connection) || undefined}
                  >
                    <div>
                      <h3>
                        {connection.name}
                        <span className="agent-kind">
                          {connection.kind === "oauth"
                            ? "вход через браузер"
                            : "токен"}
                        </span>
                      </h3>
                      <p className="agent-status-line">
                        {connectionStatus(connection)}
                      </p>
                      <p className="agent-meta">
                        Может: {scopeLabels(connection.scopes)}
                      </p>
                      {connection.kind === "oauth" &&
                        isActive(connection) &&
                        connection.scopes.includes("sign_in") && (
                        <label className="agent-meta agent-sign-in-links">
                          <input
                            type="checkbox"
                            checked={connection.signInLinks !== false}
                            disabled={action !== null}
                            onChange={() => void toggleSignInLinks(connection)}
                          />{" "}
                          Может давать ссылку для входа во временную полку («Открой мою Полку»)
                        </label>
                      )}
                      <p className="agent-meta">
                        Подключено {formatDate(connection.createdAt)}
                        {isActive(connection)
                          ? ` · действует до ${formatDate(connection.expiresAt)}${
                              connection.kind === "oauth"
                                ? ", продлевается при использовании"
                                : ""
                            }`
                          : ""}
                      </p>
                    </div>
                    {isActive(connection) && (
                      <Button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setRevokeError(null);
                          setConfirmRevoke(connection);
                        }}
                        disabled={action !== null}
                      >
                        {action === `revoke:${connection.id}`
                          ? "Отзываем…"
                          : "Отозвать"}
                      </Button>
                    )}
                  </article>
                ))}
            </div>
          )}
          {connections.some((connection) => !isActive(connection)) && (
            <Button
              type="button"
              onClick={() => setShowInactive((value) => !value)}
            >
              {showInactive
                ? "Скрыть отозванные и истёкшие"
                : `Показать отозванные и истёкшие (${connections.filter((connection) => !isActive(connection)).length})`}
            </Button>
          )}
          <p className="agent-help">
            Отзыв подключения не отзывает уже выданные ссылки на работы.
          </p>
        </section>
        {account && <SignInMethods />}
      </main>
      {confirmRevoke && (
        <Dialog
          title="Отозвать доступ?"
          onClose={() => setConfirmRevoke(null)}
          busy={action !== null}
        >
          <div className="dialog-body">
            <p>
              «{confirmRevoke.name}» больше не сможет обращаться к вашей полке.
              Вернуть этот доступ нельзя — понадобится новое подключение.
            </p>
            <p className="fine">
              Уже выданные ссылки на работы останутся открытыми.
            </p>
            {revokeError && <Notice tone="error">{revokeError}</Notice>}
          </div>
          <div className="dialog-footer">
            <Button
              disabled={action !== null}
              onClick={() => setConfirmRevoke(null)}
            >
              Отмена
            </Button>
            <Button
              variant="primary"
              className="danger"
              busy={action === `revoke:${confirmRevoke.id}`}
              onClick={async () => {
                if (await revoke(confirmRevoke)) setConfirmRevoke(null);
              }}
            >
              Отозвать доступ
            </Button>
          </div>
        </Dialog>
      )}
    </AppShell>
  );
}

/** One human line per connection: what it is doing now. */
export function connectionStatus(
  connection: AgentConnection,
  now = Date.now(),
) {
  if (connection.status === "revoked") return "Доступ отозван";
  if (connection.status === "expired")
    return connection.kind === "oauth"
      ? "Не использовалось 30 дней — подключите заново"
      : "Срок токена истёк";
  if (connection.lastSeenAt)
    return `Работает · последний раз ${relativeTime(connection.lastSeenAt, now)}`;
  return connection.kind === "oauth"
    ? "Доступ разрешён · запросов ещё не было"
    : "Токен выдан · запросов ещё не было";
}

/** Connected: the first task, «соберите свои лучшие работы», ready to copy. */
export function NextStep({
  client,
  onClient,
}: {
  client: HarvestClientId;
  onClient: (id: HarvestClientId) => void;
}) {
  return (
    <section className="agent-next" aria-labelledby="agent-next-title">
      <h2 id="agent-next-title">Что дальше: соберите свои лучшие работы</h2>
      <p className="agent-help">
        Скопируйте задание агенту: он найдёт 3–5 лучших работ, покажет список и
        после вашего «да» сохранит их на Полку.
      </p>
      <HarvestPrompt client={client} onClient={onClient} />
    </section>
  );
}

/** The numbered steps for one client, each thing to copy under its step. */
export function SetupPanel({
  setup,
  waiting,
}: {
  setup: ClientSetup;
  /** The page is polling: say so, so nobody presses «Обновить» in a loop. */
  waiting: boolean;
}) {
  return (
    <section
      className="agent-setup"
      aria-labelledby="agent-setup-title"
      data-client={setup.id}
    >
      <h3 id="agent-setup-title">{setup.title}</h3>
      <p className="agent-setup-intro">{setup.intro}</p>
      <ol className="agent-setup-steps">
        {setup.steps.map((step, index) => (
          <li key={index}>
            <span className="agent-setup-number" aria-hidden="true">
              {index + 1}
            </span>
            <div className="agent-setup-body">
              <p>{step.text}</p>
              {step.copies?.map((copy) => (
                <CopyBlock key={copy.kind + copy.value} copy={copy} />
              ))}
              {step.note && <p className="agent-setup-note">{step.note}</p>}
            </div>
          </li>
        ))}
      </ol>
      {setup.footnote && <p className="agent-setup-note">{setup.footnote}</p>}
      {waiting && (
        <p className="agent-setup-waiting" role="status">
          Как только агент подключится, здесь появится «Готово».
        </p>
      )}
    </section>
  );
}

function CopyBlock({ copy }: { copy: SetupCopy }) {
  return (
    <div className="agent-copy" data-kind={copy.kind}>
      {copy.lead && <span className="agent-copy-lead">{copy.lead}</span>}
      <div className="agent-copy-row">
        <code>{copy.value}</code>
        <CopyButton
          value={copy.value}
          label={copy.label}
          successText={copy.copied}
          variant={copy.kind === "command" ? "secondary" : "primary"}
        />
      </div>
    </div>
  );
}

function InstructionBlock({
  title,
  value,
  copyLabel = "Скопировать безопасную конфигурацию",
  copiedLabel = "Конфигурация скопирована",
}: {
  title: string;
  value: string;
  copyLabel?: string;
  copiedLabel?: string;
}) {
  return (
    <div className="agent-instruction-block">
      <h4>{title}</h4>
      <pre>
        <code>{value}</code>
      </pre>
      <CopyButton value={value} label={copyLabel} successText={copiedLabel} />
    </div>
  );
}
