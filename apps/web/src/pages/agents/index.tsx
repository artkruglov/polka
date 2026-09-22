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
import { Check, Copy, RefreshCw, ShieldCheck, X } from "lucide-react";
import { z } from "zod";
import type {
  AgentConnection,
  AgentScope,
} from "../../../../../packages/contracts/index.ts";
import { ApiError, client } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";

const scopeOptions: Array<{
  id: AgentScope;
  label: string;
  description: string;
  defaultOn: boolean;
}> = [
  {
    id: "context",
    label: "Сведения и статус",
    description:
      "Сведения о подключении, лимиты и статус собственных сохранений.",
    defaultOn: true,
  },
  {
    id: "capture",
    label: "Сохранять новые работы",
    description: "Сохранять файлы через MCP и импортировать поддерживаемые ссылки, если импорт включён.",
    defaultOn: true,
  },
  {
    id: "read",
    label: "Читать список",
    description: "Показывать агенту список сохранённых работ.",
    defaultOn: false,
  },
  {id:"source:read",label:"Читать исходники и шаблоны",description:"Получать содержимое выбранных версий всей вашей Полки. Это отдельное право, шире чтения списка.",defaultOn:false},
  {
    id: "revise",
    label: "Создавать версии",
    description: "Добавлять версии существующих работ.",
    defaultOn: false,
  },
  {
    id: "share",
    label: "Управлять ссылками",
    description: "Выдавать и отзывать ссылки для всей Полки.",
    defaultOn: false,
  },
  {
    id: "manage",
    label: "Управлять названиями, папками и корзиной",
    description:
      "Переименовывать, перемещать, отправлять в корзину и восстанавливать работы.",
    defaultOn: false,
  },
];

const statusText: Record<AgentConnection["status"], string> = {
  issued: "Токен выдан; запросов пока нет",
  seen: "Получен запрос с этим токеном",
  expired: "Срок истёк",
  revoked: "Доступ отозван",
};
const clientDefaults = {
  codex: "Codex CLI",
  claude: "Claude Code",
  other: "MCP-клиент",
} as const;
const agentScope = z.enum([
  "context",
  "read",
  "source:read",
  "capture",
  "revise",
  "share",
  "manage",
]);
const agentConnectionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  scopes: z.array(agentScope),
  audience: z
    .string()
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  status: z.enum(["issued", "seen", "expired", "revoked"]),
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
  const [clientKind, setClientKind] = useState<"codex" | "claude" | "other">(
    "codex",
  );
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
  const [copyState, setCopyState] = useState<string | null>(null);
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
      const classification = classifyIssueError(error);
      if (classification.kind === "session") {
        goToLogin();
        return;
      }
      if (classification.kind === "form") {
        setFormError(classification.message);
        return;
      }
      setListState("error");
      setListError("Не удалось загрузить подключения. Повторите попытку.");
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

  const revoke = async (connection: AgentConnection) => {
    if (actionRef.current) return;
    setBusy(`revoke:${connection.id}`);
    setFormError(null);
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      const csrf = await client.agentConnections.csrf(controller.signal);
      await client.agentConnections.revoke(
        connection.id,
        csrf.csrfToken,
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted) return;
      await refresh();
      if (secret?.connection.id === connection.id) setSecret(null);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        goToLogin();
        return;
      }
      setFormError("Не удалось отозвать доступ. Повторите попытку.");
    } finally {
      if (actionAbort.current === controller) actionAbort.current = null;
      if (actionRef.current === `revoke:${connection.id}`) setBusy(null);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      if (mounted.current) {
        setCopyState(label);
        window.setTimeout(() => mounted.current && setCopyState(null), 1800);
      }
    } catch {
      if (mounted.current) setCopyState(null);
    }
  };

  const endpoint = secret?.connection.audience ?? "";
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
          <span className="eyebrow">Ваш агент → ваша Полка</span>
          <h1>Подключить агента</h1>
          <p className="agent-lead">
            Claude Code, Codex или другой MCP-клиент будет сохранять работы
            прямо на вашу Полку — и только то, что вы разрешили.
          </p>
          <p className="agent-boundary">
            <ShieldCheck size={17} /> Настройка через токен. Вход через OAuth
            здесь не используется.
          </p>
        </header>
        <ol className="agent-steps" aria-label="Как подключить">
          <li>
            <span>1</span>
            <div>
              <strong>Создайте подключение</strong>
              <p>Назовите его, выберите клиента и разрешения.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Передайте токен клиенту</strong>
              <p>Через переменную окружения — не через чат.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Попросите агента сохранить</strong>
              <p>Работа появится на Полке; статус видно здесь.</p>
            </div>
          </li>
        </ol>
        <div className="agent-workspace">
          <div className="agent-setup-column">
            <section className="agent-card" aria-labelledby="new-agent-title">
              <h2 id="new-agent-title">Новое подключение</h2>
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
                    Разрешения действуют на всю Полку, а не на одну папку.
                    Чтение списка и каждое действие включаются отдельно.
                  </p>
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
                <Button
                  type="button"

                  onClick={() => void copy(secret.token, "token")}
                >
                  {copyState === "token" ? (
                    <Check size={16} />
                  ) : (
                    <Copy size={16} />
                  )}{" "}
                  {copyState === "token"
                    ? "Токен скопирован"
                    : "Скопировать токен"}
                </Button>
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
                    onCopy={() => void copy(codexCommand, "config")}
                    copied={copyState === "config"}
                  />
                )}
                {clientKind === "claude" && (
                  <InstructionBlock
                    title="Claude Code — добавьте в существующий .mcp.json"
                    value={claudeConfig}
                    onCopy={() => void copy(claudeConfig, "config")}
                    copied={copyState === "config"}
                  />
                )}
                {clientKind === "other" && (
                  <p className="agent-instruction">
                    Используйте Streamable HTTP endpoint и Authorization Bearer
                    из секрета. Совместимость конкретного клиента проверьте в
                    его документации.
                  </p>
                )}
                <p className="agent-instruction">
                  <code>read -r -s POLKA_MCP_TOKEN</code>, затем вставьте токен
                  и нажмите Enter; после этого выполните{" "}
                  <code>export POLKA_MCP_TOKEN</code>. Клиент запускается из
                  этого же терминала.
                </p>
                <p className="agent-next-step">
                  Попросите клиента вызвать <code>polka_context</code>, затем
                  обновите состояние здесь.
                </p>
              </section>
            )}
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
                  сохранения проверяйте на Полке.
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
                <Button
                  type="button"

                  onClick={() => void refresh()}
                >
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
                        {statusText[connection.status]}
                      </p>
                      <p className="agent-meta">
                        {connection.scopes
                          .map(
                            (id) =>
                              scopeOptions.find((scope) => scope.id === id)
                                ?.label ?? id,
                          )
                          .join(" · ")}{" "}
                        · истекает {formatDate(connection.expiresAt)}
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
                        onClick={() => void revoke(connection)}
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
      </main>
    </AppShell>
  );
}

function InstructionBlock({
  title,
  value,
  onCopy,
  copied,
}: {
  title: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="agent-instruction-block">
      <h4>{title}</h4>
      <pre>
        <code>{value}</code>
      </pre>
      <Button type="button" onClick={onCopy}>
        {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
        {copied
          ? "Конфигурация скопирована"
          : "Скопировать безопасную конфигурацию"}
      </Button>
    </div>
  );
}
