import React, { useState } from "react";
import { AlertTriangle, ExternalLink, FileText, GitPullRequest, KeyRound } from "lucide-react";
import { Badge, Button } from "../../shared/ui/controls.tsx";
import { CopyText } from "../../shared/ui/CopyText.tsx";
import {
  ALERT_HINT,
  ALERT_LABEL,
  KIND_LABEL,
  SECRETS_LABEL,
  SECRETS_TONE,
  SOURCE_LABEL,
  STATUS_LABEL,
  barWidth,
  compactNumber,
  formatBytes,
  formatCost,
  formatDuration,
  formatWhen,
  permissionLabel,
  plural,
  secretFlags,
  sessionDuration,
  sessionUrl,
  type AgentSession,
  type Fingerprint,
  type SessionLink,
  type SessionSecret,
  type SessionStats,
  type ToolCall,
  type TranscriptEvent,
  SESSION_PATH,
} from "../../entities/agent-session/model.ts";

export type SessionsView = "list" | "secrets" | "usage";

/** Which part of «Сессии агентов» a path opens. */
export function sessionsRoute(path: string): { view: SessionsView } | { view: "session"; id: string } {
  const one = SESSION_PATH.exec(path);
  if (one) return { view: "session", id: one[1]! };
  if (path === "/sessions/secrets") return { view: "secrets" };
  if (path === "/sessions/usage") return { view: "usage" };
  return { view: "list" };
}

/** «Сессии · Секреты · Расход»: separate addresses, so plain links. */
export function SessionsTabs({ current }: { current: SessionsView }) {
  const tabs: { id: SessionsView; label: string; href: string }[] = [
    { id: "list", label: "Сессии", href: "/sessions" },
    { id: "secrets", label: "Секреты", href: "/sessions/secrets" },
    { id: "usage", label: "Расход", href: "/sessions/usage" },
  ];
  return (
    <nav className="sessions-tabs" aria-label="Разделы сессий">
      {tabs.map((tab) => (
        <a key={tab.id} href={tab.href} aria-current={tab.id === current ? "page" : undefined}>
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

export function QuotaBar({ used, quota }: { used: number; quota: number }) {
  if (!quota) return null;
  return (
    <div className="sessions-quota" aria-label="Место для сессий">
      <span className="sessions-quota-track">
        <span style={{ width: barWidth(Math.min(used, quota), quota) }} />
      </span>
      <small>
        {formatBytes(used)} из {formatBytes(quota)}
      </small>
    </div>
  );
}

/** Sessions are off on this shelf: who turns them on and what comes next. */
export function SessionsOff() {
  return (
    <section className="sessions-card">
      <h2>Сессии агентов на этой полке выключены</h2>
      <p>
        Здесь появляется история работы ваших агентов Claude Code и Codex: какие команды они запускали, куда обращались,
        какие секреты видели и сколько это стоило. Секреты скрываются ещё на вашем компьютере, на Полку попадает только
        отчёт о них.
      </p>
      <p className="sessions-muted">
        Место для сессий включает оператор вашей установки Полки. Когда оно появится: выпустите на странице «Агенты»
        токен с правом «Сессии агентов», выполните <code>polka-sessions login</code>, а чтобы сессии Claude Code
        отправлялись сами — задайте <code>POLKA_SESSIONS=on</code>.
      </p>
    </section>
  );
}

export function setupCommands(origin: string) {
  return {
    download: `curl -fsSLO ${origin}/api/v1/cli/polka-sessions.mjs`,
    login: "pbpaste | node polka-sessions.mjs login",
    preview: "node polka-sessions.mjs list --since 1d\nnode polka-sessions.mjs preview <id сессии>",
    sync: "node polka-sessions.mjs sync --since 7d",
    hook: "export POLKA_SESSIONS=on",
  };
}

/** Enabled, nothing sent yet: how to send the first sessions. */
export function SessionsStart({ origin }: { origin: string }) {
  const commands = setupCommands(origin);
  return (
    <section className="sessions-card">
      <h2>Отправьте первые сессии</h2>
      <ol className="sessions-steps">
        <li>
          Скачайте программу (Node.js 22, без зависимостей):
          <CopyText value={commands.download} label="Команда скачивания" rows={1} />
        </li>
        <li>
          На странице <a href="/settings/agents">«Агенты»</a> выпустите токен с правом «Сессии агентов», скопируйте его
          и сохраните на компьютере (токен лежит в <code>~/.polka</code>, доступ только у вас):
          <CopyText value={commands.login} label="Команда входа" rows={1} />
        </li>
        <li>
          Посмотрите, что уйдёт на Полку, — команда ничего не отправляет:
          <CopyText value={commands.preview} label="Команды просмотра" rows={2} />
        </li>
        <li>
          Отправьте сессии за неделю:
          <CopyText value={commands.sync} label="Команда отправки" rows={1} />
        </li>
        <li>
          С плагином Полки сессия Claude Code отправляется сама, когда закончится. Включите это в профиле оболочки:
          <CopyText value={commands.hook} label="Включить отправку после сессии" rows={1} />
          Для Codex повторяйте <code>sync</code> — вручную или по расписанию.
        </li>
      </ol>
      <p className="sessions-muted">
        Секреты заменяются на метки ещё на компьютере, рассуждения модели не отправляются. Сессии видите только вы.
      </p>
    </section>
  );
}

export function SecretsBadge({ status }: { status: AgentSession["secretsStatus"] }) {
  return <Badge tone={SECRETS_TONE[status]}>{status === "clean" ? "секретов нет" : SECRETS_LABEL[status]}</Badge>;
}

export function SessionRow({ session }: { session: AgentSession }) {
  return (
    <li className="sessions-row">
      <a href={sessionUrl(session.id)}>
        <strong>{session.projectLabel ?? "Без проекта"}</strong>
        <small>
          {SOURCE_LABEL[session.source]}
          {session.gitBranch ? ` · ${session.gitBranch}` : ""} · {formatWhen(session.startedAt ?? session.uploadedAt)} ·{" "}
          {formatDuration(sessionDuration(session))}
        </small>
      </a>
      <span className="sessions-row-facts">
        <span>{plural(session.toolCallCount, "вызов", "вызова", "вызовов")}</span>
        <span>{compactNumber(session.tokens.output)} ток. вывода</span>
        <span>
          {formatCost(session.costUSD)}
          {session.costEstimated && session.costUSD !== null ? " (оценка)" : ""}
        </span>
      </span>
      <span className="sessions-row-flags">
        <SecretsBadge status={session.secretsStatus} />
        {session.alerts.map((alert) => (
          <Badge key={alert.rule} tone="warning" title={ALERT_HINT[alert.rule]}>
            {ALERT_LABEL[alert.rule]}
          </Badge>
        ))}
      </span>
    </li>
  );
}

export function SessionFacts({ session }: { session: AgentSession }) {
  const facts: [string, React.ReactNode][] = [
    ["Агент", `${SOURCE_LABEL[session.source]}${session.cliVersion ? ` ${session.cliVersion}` : ""}`],
    ["Проект", session.projectLabel ?? "—"],
    ["Ветка", session.gitBranch ?? "—"],
    ["Начало", formatWhen(session.startedAt)],
    ["Длительность", formatDuration(sessionDuration(session))],
    ["Запросы", String(session.prompts)],
    ["Вызовы инструментов", String(session.toolCallCount)],
    [
      "Токены",
      `ввод ${compactNumber(session.tokens.input)}, вывод ${compactNumber(session.tokens.output)}, кэш ${compactNumber(session.tokens.cacheRead)}`,
    ],
    [
      "Стоимость",
      `${formatCost(session.costUSD)}${session.costEstimated && session.costUSD !== null ? " (оценка по ценам установки)" : ""}`,
    ],
    ["Подтверждения", permissionLabel(session.permissionMode)],
  ];
  return (
    <dl className="sessions-facts">
      {facts.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AlertList({ alerts }: { alerts: AgentSession["alerts"] }) {
  if (!alerts.length) return null;
  return (
    <ul className="sessions-alerts" aria-label="Предупреждения">
      {alerts.map((alert) => (
        <li key={alert.rule}>
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>{ALERT_LABEL[alert.rule]}</strong>
            {alert.count > 1 ? ` · ${alert.count}` : ""}
            {alert.firstSeq !== null ? (
              <>
                {" "}
                · <a href={`#call-${alert.firstSeq}`}>первый вызов</a>
              </>
            ) : null}
            <small>{ALERT_HINT[alert.rule]}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Never a value: type, fingerprint, prefix, where it went. */
export function SecretsTable({ secrets }: { secrets: SessionSecret[] }) {
  if (!secrets.length) return <p className="sessions-muted">Секретов в этой сессии не найдено.</p>;
  return (
    <div className="sessions-table-wrap">
      <table className="sessions-table">
        <thead>
          <tr>
            <th>Тип</th>
            <th>Отпечаток</th>
            <th>Где</th>
            <th>Сессий</th>
          </tr>
        </thead>
        <tbody>
          {secrets.map((secret) => (
            <tr key={secret.fingerprint} className={secret.toNetwork ? "sessions-danger" : undefined}>
              <td>
                <KeyRound aria-hidden="true" /> {secret.type}
                {secret.prefix ? <small> {secret.prefix}…</small> : null}
              </td>
              <td>
                <code>{secret.fingerprint}</code>
              </td>
              <td>{secretFlags(secret).join(", ") || "—"}</td>
              <td title="В скольких ваших сессиях встречается этот же секрет">{secret.sessions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LinkList({ links }: { links: SessionLink[] }) {
  if (!links.length) return null;
  return (
    <ul className="sessions-links">
      {links.map((link) =>
        link.kind === "work" ? (
          <li key={link.target}>
            <FileText aria-hidden="true" />{" "}
            {link.artifactId ? (
              <a href={`/works/${link.artifactId}`}>{link.title ?? "Работа на полке"}</a>
            ) : (
              "Работа удалена"
            )}
          </li>
        ) : (
          <li key={link.target}>
            <GitPullRequest aria-hidden="true" />{" "}
            <a href={link.target} target="_blank" rel="noopener noreferrer">
              {link.target.replace(/^https:\/\/(?:www\.)?/, "")} <ExternalLink aria-hidden="true" />
            </a>
          </li>
        ),
      )}
    </ul>
  );
}

export const CALLS_SHOWN = 200;

export function ToolCallList({ calls }: { calls: ToolCall[] }) {
  const [all, setAll] = useState(false);
  if (!calls.length) return <p className="sessions-muted">Агент не вызывал инструментов.</p>;
  const shown = all ? calls : calls.slice(0, CALLS_SHOWN);
  return (
    <>
      <ol className="sessions-calls">
        {shown.map((call) => (
          <li key={call.seq} id={`call-${call.seq}`} data-status={call.status}>
            <span className="sessions-call-kind">{KIND_LABEL[call.kind]}</span>
            <span className="sessions-call-main">
              <code>{call.template ?? call.tool}</code>
              {call.template && call.tool !== call.argv0 ? <small> {call.tool}</small> : null}
              {call.subagent ? <small> · подагент</small> : null}
              {call.hosts.length ? <small className="sessions-call-hosts"> → {call.hosts.join(", ")}</small> : null}
            </span>
            <span className="sessions-call-status">
              {STATUS_LABEL[call.status]}
              {call.exitCode !== null && call.exitCode !== 0 ? ` (код ${call.exitCode})` : ""} ·{" "}
              {formatDuration(call.durationMs)}
            </span>
          </li>
        ))}
      </ol>
      {!all && calls.length > CALLS_SHOWN && (
        <Button variant="quiet" onClick={() => setAll(true)}>
          Показать все {calls.length}
        </Button>
      )}
    </>
  );
}

const EVENT_LABEL: Record<TranscriptEvent["type"], string> = {
  prompt: "Человек",
  assistant: "Агент",
  tool_call: "Вызов",
  tool_result: "Результат",
  thinking: "Рассуждение",
  unreadable: "Нечитаемая запись",
};

export function TranscriptEvents({ events }: { events: TranscriptEvent[] }) {
  return (
    <ol className="sessions-transcript">
      {events.map((event, index) => (
        <li key={index} data-type={event.type}>
          <span className="sessions-transcript-who">
            {EVENT_LABEL[event.type] ?? event.type}
            {event.tool ? ` · ${event.tool}` : ""}
            {event.type === "tool_result" && event.status && event.status !== "ok" ? ` · ${event.status}` : ""}
          </span>
          <pre>{event.text ?? event.input ?? event.output ?? ""}</pre>
        </li>
      ))}
    </ol>
  );
}

export function FingerprintTable({ fingerprints }: { fingerprints: Fingerprint[] }) {
  if (!fingerprints.length) return <p className="sessions-muted">За этот период секретов в сессиях не найдено.</p>;
  return (
    <div className="sessions-table-wrap">
      <table className="sessions-table">
        <thead>
          <tr>
            <th>Тип</th>
            <th>Отпечаток</th>
            <th>Где</th>
            <th>Сессий</th>
            <th>Последний раз</th>
          </tr>
        </thead>
        <tbody>
          {fingerprints.map((item) => (
            <tr key={item.fingerprint} className={item.toNetwork ? "sessions-danger" : undefined}>
              <td>
                {item.type}
                {item.prefix ? <small> {item.prefix}…</small> : null}
              </td>
              <td>
                <code>{item.fingerprint}</code>
              </td>
              <td>{secretFlags({ ...item, modelEmitted: false }).join(", ") || "—"}</td>
              <td>{item.sessions}</td>
              <td>
                <a href={sessionUrl(item.lastSessionId)}>{formatWhen(item.lastSeen)}</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SecretsSummary({ stats }: { stats: SessionStats }) {
  const order = ["sent_out", "used", "seen", "clean"] as const;
  return (
    <ul className="sessions-summary">
      {order.map((status) => (
        <li key={status} data-status={status}>
          <strong>{stats.secrets[status] ?? 0}</strong>
          <small>{status === "clean" ? "чистых сессий" : SECRETS_LABEL[status]}</small>
        </li>
      ))}
    </ul>
  );
}

export function UsageView({ stats }: { stats: SessionStats }) {
  const maxDay = Math.max(0, ...stats.byDay.map((day) => day.output));
  const maxModel = Math.max(0, ...stats.byModel.map((model) => model.output));
  const costNote = stats.totals.withoutCost
    ? `без цены: ${plural(stats.totals.withoutCost, "сессия", "сессии", "сессий")}`
    : stats.totals.someEstimated
      ? "часть — оценка по ценам установки"
      : "";
  return (
    <div className="sessions-usage">
      <ul className="sessions-summary">
        <li>
          <strong>{stats.totals.sessions}</strong>
          <small>сессий</small>
        </li>
        <li>
          <strong>{compactNumber(stats.totals.toolCalls)}</strong>
          <small>вызовов инструментов</small>
        </li>
        <li>
          <strong>{formatCost(stats.totals.cost)}</strong>
          <small>{costNote || "стоимость"}</small>
        </li>
      </ul>
      <section className="sessions-card">
        <h2>Токены вывода по дням</h2>
        {stats.byDay.length ? (
          <ol className="sessions-bars">
            {stats.byDay.map((day) => (
              <li key={day.day}>
                <span>
                  {new Date(`${day.day}T00:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                </span>
                <span className="sessions-bar">
                  <span style={{ width: barWidth(day.output, maxDay) }} />
                </span>
                <small>
                  {compactNumber(day.output)} · {plural(day.sessions, "сессия", "сессии", "сессий")}
                  {day.cost ? ` · ${formatCost(day.cost)}` : ""}
                </small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="sessions-muted">За этот период сессий нет.</p>
        )}
      </section>
      <section className="sessions-card">
        <h2>Модели</h2>
        {stats.byModel.length ? (
          <ol className="sessions-bars">
            {stats.byModel.map((model) => (
              <li key={model.model}>
                <span>{model.model}</span>
                <span className="sessions-bar">
                  <span style={{ width: barWidth(model.output, maxModel) }} />
                </span>
                <small>
                  вывод {compactNumber(model.output)}, ввод {compactNumber(model.input)}, кэш{" "}
                  {compactNumber(model.cacheRead)}
                </small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="sessions-muted">Нет данных о моделях.</p>
        )}
      </section>
      <div className="sessions-columns">
        <section className="sessions-card">
          <h2>Куда обращались агенты</h2>
          {stats.hosts.length ? (
            <ul className="sessions-plain">
              {stats.hosts.map((host) => (
                <li key={host.host}>
                  <code>{host.host}</code>
                  <small>
                    {plural(host.calls, "вызов", "вызова", "вызовов")} в{" "}
                    {plural(host.sessions, "сессии", "сессиях", "сессиях")}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sessions-muted">Обращений в сеть не найдено.</p>
          )}
        </section>
        <section className="sessions-card">
          <h2>MCP-серверы</h2>
          {stats.mcp.length ? (
            <ul className="sessions-plain">
              {stats.mcp.map((server) => (
                <li key={server.server}>
                  <code>{server.server}</code>
                  <small>
                    {plural(server.calls, "вызов", "вызова", "вызовов")}
                    {server.errors ? `, ошибок: ${server.errors}` : ""}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sessions-muted">MCP-серверы не вызывались.</p>
          )}
        </section>
      </div>
      {stats.alerts.length > 0 && (
        <section className="sessions-card">
          <h2>Предупреждения</h2>
          <ul className="sessions-plain">
            {stats.alerts.map((alert) => (
              <li key={alert.rule}>
                <strong>{ALERT_LABEL[alert.rule]}</strong>
                <small>{plural(alert.sessions, "сессия", "сессии", "сессий")}</small>
              </li>
            ))}
          </ul>
          <a href="/sessions?alerts=any">Открыть эти сессии</a>
        </section>
      )}
    </div>
  );
}
