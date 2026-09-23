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
import { RefreshCw, ShieldCheck, X } from "lucide-react";
import { z } from "zod";
import {
  agentScopeSchema,
  type AgentConnection,
  type AgentScope,
} from "../../../../../packages/contracts/index.ts";
import { ApiError, client } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { scopeOptions } from "../../entities/agent-scope/scopes.ts";
import { Tabs } from "../../shared/ui/Tabs.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import { Dialog } from "../../shared/ui/index.tsx";
import { SignInMethods } from "../../features/provider-sign-in/index.tsx";

const statusText: Record<AgentConnection["status"], string> = {
  issued: "Токен выдан; запросов пока нет",
  seen: "Получен запрос с этим токеном",
  expired: "Срок истёк",
  revoked: "Доступ отозван",
};
const oauthStatusText: Record<AgentConnection["status"], string> = {
  issued: "Доступ разрешён; запросов пока нет",
  seen: "Коннектор обращался к Полке",
  expired: "Не использовался 30 дней — подключите заново",
  revoked: "Доступ отозван",
};
const clientDefaults = {
  codex: "Codex CLI",
  claude: "Claude Code",
  other: "MCP-клиент",
  http: "Скрипт (HTTP API)",
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

export function AgentConnections() {
  const account = useAccount();
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [listError, setListError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [clientKind, setClientKind] = useState<ClientKind>("codex");
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
  const [confirmRevoke, setConfirmRevoke] = useState<AgentConnection | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const listAbort = useRef<AbortController | null>(null);
  const actionAbort = useRef<AbortController | null>(null);
  const actionRef = useRef<string | null>(null);
  const mounted = useRef(true);

  const goToLogin = useCallback(() => {
    actionAbort.current?.abort();
    actionRef.current = null;
    setAction(null);
    setSecret(null);
    setShowSecret(false);
    const next = `${location.pathname}${location.search}${location.hash}`;
    location.assign(`/signup?next=${encodeURIComponent(next)}`);
  }, []);

  const refresh = useCallback(async () => {
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    setListState("loading");
    setListError(null);
    try {
      const result = agentConnectionsSchema.parse(
        await client.agentConnections.list(controller.signal),
      );
      if (!mounted.current || controller.signal.aborted) return;
      setConnections(result);
      setListState("ready");
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      if (classifyIssueError(error).kind === "session") {
        goToLogin();
        return;
      }
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
  }, [goToLogin]);

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

  const endpoint = secret?.connection.audience ?? "";
  const tokenVariable = clientKind === "http" ? "POLKA_TOKEN" : "POLKA_MCP_TOKEN";
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
  // No token at all: the client registers itself (OAuth), opens the browser,
  // the owner signs in and allows access. Nothing secret to copy.
  const codexOAuthCommand = useMemo(
    () => `codex mcp add polka --url ${shellQuote(endpoint)}`,
    [endpoint],
  );
  const claudeOAuthCommand = useMemo(
    () =>
      `claude mcp add --transport http --scope user polka ${shellQuote(endpoint)}`,
    [endpoint],
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

  return (
    <AppShell
      current="connections"
      account={account}
      className="agent-connections-page"
    >
      <main className="agent-connections" id="main">
        <header className="agent-page-heading">
          <span className="eyebrow">Ваш агент → ваша полка</span>
          <h1>Подключить агента</h1>
          <p className="agent-lead">
            Claude Code, Codex или другой MCP-клиент будет сохранять работы
            прямо на вашу полку — и только то, что вы разрешили.
          </p>
          <p className="agent-boundary">
            <ShieldCheck size={17} /> Проще всего — одной командой ниже: токен
            не нужен, клиент откроет Полку в браузере, вы войдёте и разрешите
            доступ. Claude.ai и ChatGPT подключаются так же: добавьте в них
            коннектор {new URL("/mcp", location.origin).href}. Все подключения
            появятся в списке, и любое можно отозвать.
          </p>
        </header>
        <ol className="agent-steps" aria-label="Как подключить">
          <li>
            <span>1</span>
            <div>
              <strong>Подключите клиента</strong>
              <p>Одной командой ниже или подключением с токеном.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Разрешите доступ</strong>
              <p>На странице Полки, которую откроет клиент. Токен — только через переменную окружения, не через чат.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Попросите агента сохранить</strong>
              <p>Работа появится на вашей полке; статус видно здесь.</p>
            </div>
          </li>
        </ol>
        <div className="agent-workspace">
          <div className="agent-setup-column">
            <section className="agent-card" aria-labelledby="one-command-title">
              <h2 id="one-command-title">Одной фразой, без токена</h2>
              <p className="agent-instruction">
                Скажите это своему агенту. Он сам выполнит нужную команду,
                откроется Полка: войдите и нажмите «Разрешить».
              </p>
              <InstructionBlock
                title="Codex, Claude Code, Claude.ai, ChatGPT"
                value={`Подключи Полку: ${location.origin}/connect`}
                copyLabel="Скопировать фразу"
                copiedLabel="Фраза скопирована"
              />
              <p className="agent-instruction">Или выполните команду сами:</p>
              <InstructionBlock
                title="Codex"
                value={codexOAuthCommand}
                copyLabel="Скопировать команду"
                copiedLabel="Команда скопирована"
              />
              <InstructionBlock
                title="Claude Code — затем в Claude Code: /mcp → polka → Authenticate"
                value={claudeOAuthCommand}
                copyLabel="Скопировать команду"
                copiedLabel="Команда скопирована"
              />
              <p className="agent-instruction">
                Клиент без входа через браузер? Создайте подключение с токеном
                ниже.
              </p>
            </section>
            <section className="agent-card" aria-labelledby="new-agent-title">
              <h2 id="new-agent-title">Подключение с токеном</h2>
              <form onSubmit={issue}>
                <TextField
                  label="Имя подключения"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  placeholder="Например, рабочий Codex"
                  required
                />
                <fieldset>
                  <legend>Клиент</legend>
                  <div className="agent-choice-row">
                    {(
                      [
                        ["codex", "Codex CLI"],
                        ["claude", "Claude Code"],
                        ["other", "Другой MCP-клиент"],
                        ["http", "HTTP API / скрипт"],
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
                    {scopeOptions.map((scope) => (
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
                  {action === "issue" ? "Подключаем…" : "Создать подключение"}
                </Button>
              </form>
            </section>

            {secret && (
              <section
                className="agent-card agent-secret"
                aria-labelledby="agent-secret-title"
              >
                <div className="agent-card-heading">
                  <div>
                    <h2 id="agent-secret-title">Токен подключения</h2>
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
                    <dd>
                      {secret.connection.scopes
                        .map(
                          (id) =>
                            scopeOptions.find((scope) => scope.id === id)
                              ?.label ?? id,
                        )
                        .join(" · ")}
                    </dd>
                  </div>
                  <div>
                    <dt>Истекает</dt>
                    <dd>{formatDate(secret.connection.expiresAt)}</dd>
                  </div>
                </dl>
                <h3>Настройка клиента</h3>
                <p className="agent-help">
                  Переменная должна быть доступна процессу клиента. Не
                  вставляйте токен в чат.
                </p>
                {clientKind === "codex" && (
                  <InstructionBlock
                    title="Codex CLI"
                    value={codexCommand}
                  />
                )}
                {clientKind === "claude" && (
                  <InstructionBlock
                    title="Claude Code — добавьте в существующий .mcp.json"
                    value={claudeConfig}
                  />
                )}
                {clientKind === "http" && (
                  <p className="agent-instruction">
                    Команды для публикации — в карточке «HTTP API и CLI» ниже:
                    CLI и API читают токен из переменной{" "}
                    <code>POLKA_TOKEN</code>.
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
                      Опубликуйте файл командой ниже, затем обновите состояние
                      здесь.
                    </>
                  ) : (
                    <>
                      Попросите клиента вызвать <code>polka_context</code>,
                      затем обновите состояние здесь.
                    </>
                  )}
                </p>
              </section>
            )}

            <section
              className="agent-card agent-http"
              aria-labelledby="agent-http-title"
            >
              <h2 id="agent-http-title">HTTP API и CLI</h2>
              <p className="agent-help">
                Для внутренних агентов, CI и скриптов без MCP: один запрос{" "}
                <code>POST /api/v1/publish</code> сохраняет HTML-страницу и,
                если подключению разрешено управлять ссылками, возвращает
                ссылку. Нужен токен с разрешением «
                {scopeOptions.find((scope) => scope.id === "capture")?.label}».
                Токен — только в заголовке Authorization и переменной
                окружения, не в аргументах и не в чате.
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
          <section
            className="agent-card agent-existing"
            aria-labelledby="agent-list-title"
          >
            <div className="agent-card-heading">
              <div>
                <h2 id="agent-list-title">Существующие подключения</h2>
                <p>
                  Запрос от агента ещё не означает, что файл сохранён. Результат
                  сохранения проверяйте на вашей полке.
                </p>
              </div>
              <Button
                type="button"
                onClick={() => void refresh()}
                disabled={listState === "loading"}
              >
                <RefreshCw size={16} /> Обновить состояние
              </Button>
            </div>
            {listState === "loading" && (
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
            {listState === "ready" && connections.length === 0 && (
              <div className="agent-empty">
                <strong>Подключений пока нет</strong>
                Создайте первое слева: токен покажем один раз, а здесь будет
                видно, когда агент им воспользовался.
              </div>
            )}
            {listState === "ready" && connections.length > 0 && (
              <div className="agent-list">
                {connections.map((connection) => (
                  <article className="agent-list-item" key={connection.id}>
                    <div>
                      <h3>{connection.name}</h3>
                      <p className="agent-status">
                        {connection.kind === "oauth"
                          ? oauthStatusText[connection.status]
                          : statusText[connection.status]}
                      </p>
                      <p className="agent-meta">
                        {connection.scopes
                          .map(
                            (id) =>
                              scopeOptions.find((scope) => scope.id === id)
                                ?.label ?? id,
                          )
                          .join(" · ")}
                        {connection.kind === "oauth"
                          ? " · коннектор чата · действует до "
                          : " · истекает "}
                        {formatDate(connection.expiresAt)}
                        {connection.kind === "oauth"
                          ? " и продлевается при использовании"
                          : ""}
                        {connection.lastSeenAt
                          ? ` · последний запрос ${formatDate(connection.lastSeenAt)}`
                          : ""}
                      </p>
                    </div>
                    {(connection.status === "issued" ||
                      connection.status === "seen") && (
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
                          : "Отозвать доступ"}
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            )}
            <p className="agent-help">
              Отзыв подключения не отзывает уже выданные ссылки.
            </p>
          </section>
        </div>
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
            <p className="fine">Уже выданные ссылки на работы останутся открытыми.</p>
            {revokeError && <Notice tone="error">{revokeError}</Notice>}
          </div>
          <div className="dialog-footer">
            <Button disabled={action !== null} onClick={() => setConfirmRevoke(null)}>
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
