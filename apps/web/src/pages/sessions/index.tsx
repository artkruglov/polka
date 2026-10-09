import React, { useEffect, useState } from "react";
import { ArrowLeft, Download, Trash2 } from "lucide-react";
import { ApiError } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { Button, LinkButton, SelectField, StatusPanel } from "../../shared/ui/controls.tsx";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import {
  SOURCE_LABEL,
  SECRETS_LABEL,
  formatWhen,
  plural,
  sessionsApi,
  transcriptUrl,
  type SessionDetail,
  type SessionFilters,
  type SessionList,
  type SessionStats,
  type TranscriptEvent,
} from "../../entities/agent-session/model.ts";
import {
  AlertList,
  FingerprintTable,
  LinkList,
  QuotaBar,
  SecretsBadge,
  SecretsSummary,
  SecretsTable,
  SessionFacts,
  SessionRow,
  SessionsOff,
  SessionsStart,
  SessionsTabs,
  ToolCallList,
  TranscriptEvents,
  UsageView,
  sessionsRoute,
} from "./parts.tsx";
import "./styles.css";

// A person's Claude Code and Codex sessions (docs/specs/AGENT_SESSIONS.md):
// the list, «Секреты», «Расход» and one session. Always the own shelf.

const message = (error: unknown) => (error instanceof Error ? error.message : "Не удалось загрузить.");

function filtersFromUrl(): SessionFilters {
  const params = new URLSearchParams(location.search);
  return {
    source: (params.get("source") as SessionFilters["source"]) ?? "",
    project: params.get("project") ?? "",
    secrets: (params.get("secrets") as SessionFilters["secrets"]) ?? "",
    alerts: params.get("alerts") === "any" ? "any" : "",
  };
}

function SessionsList() {
  const [filters, setFilters] = useState<SessionFilters>(filtersFromUrl);
  const [page, setPage] = useState<SessionList | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value) as [string, string][]);
    history.replaceState(null, "", `/sessions${query.size ? `?${query}` : ""}`);
    sessionsApi
      .list(filters)
      .then((result) => live && setPage(result))
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [filters]);
  const loadMore = async () => {
    if (!page?.next) return;
    setMore(true);
    try {
      const next = await sessionsApi.list(filters, page.next);
      setPage({ ...next, sessions: [...page.sessions, ...next.sessions] });
    } catch (e) {
      setError(message(e));
    } finally {
      setMore(false);
    }
  };
  if (error && !page) return <StatusPanel title="Не удалось загрузить сессии">{error}</StatusPanel>;
  if (!page)
    return (
      <p className="sessions-muted" role="status">
        Загружаем…
      </p>
    );
  if (!page.enabled) return <SessionsOff />;
  const filtered = Object.values(filters).some(Boolean);
  const notice = page.notice && <p className="sessions-notice">{page.notice}</p>;
  if (!page.sessions.length && !filtered)
    return (
      <>
        {notice}
        <SessionsStart origin={location.origin} />
      </>
    );
  // A new filter clears the last error before its list loads.
  const set = (patch: Partial<SessionFilters>) => {
    setError("");
    setFilters((was) => ({ ...was, ...patch }));
  };
  return (
    <>
      {notice}
      <QuotaBar used={page.usedBytes} quota={page.quotaBytes} />
      <div className="sessions-filters">
        <SelectField
          label="Агент"
          value={filters.source ?? ""}
          onChange={(e) => set({ source: e.target.value as SessionFilters["source"] })}
        >
          <option value="">Все</option>
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
        </SelectField>
        <SelectField label="Проект" value={filters.project ?? ""} onChange={(e) => set({ project: e.target.value })}>
          <option value="">Все</option>
          {page.projects.map((project) => (
            <option key={project.label} value={project.label}>
              {project.label} ({project.sessions})
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Секреты"
          value={filters.secrets ?? ""}
          onChange={(e) => set({ secrets: e.target.value as SessionFilters["secrets"] })}
        >
          <option value="">Все сессии</option>
          <option value="any">Любые находки</option>
          <option value="sent_out">{SECRETS_LABEL.sent_out}</option>
          <option value="used">{SECRETS_LABEL.used}</option>
          <option value="seen">{SECRETS_LABEL.seen}</option>
          <option value="clean">Без секретов</option>
        </SelectField>
        <SelectField
          label="Предупреждения"
          value={filters.alerts ?? ""}
          onChange={(e) => set({ alerts: e.target.value as SessionFilters["alerts"] })}
        >
          <option value="">Все</option>
          <option value="any">Только с предупреждениями</option>
        </SelectField>
      </div>
      <ErrorNotice error={error} />
      {page.sessions.length ? (
        <ul className="sessions-list">
          {page.sessions.map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
        </ul>
      ) : (
        <p className="sessions-muted">Таких сессий нет. Измените отбор.</p>
      )}
      {page.next && (
        <Button busy={more} onClick={() => void loadMore()}>
          Ещё
        </Button>
      )}
    </>
  );
}

function PeriodChoice({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <SelectField label="Период" value={String(days)} onChange={(e) => onChange(Number(e.target.value))}>
      <option value="7">7 дней</option>
      <option value="30">30 дней</option>
      <option value="90">90 дней</option>
    </SelectField>
  );
}

function useStats(days: number) {
  const [state, setState] = useState<{ days?: number; stats?: SessionStats; error?: string; off?: boolean }>({});
  useEffect(() => {
    let live = true;
    Promise.all([sessionsApi.list({}, null), sessionsApi.stats(days)])
      .then(([list, stats]) => live && setState({ days, stats, off: !list.enabled }))
      .catch((e) => live && setState({ days, error: message(e) }));
    return () => {
      live = false;
    };
  }, [days]);
  // Another period starts empty until its own answer.
  return state.days === days ? state : {};
}

function SecretsView() {
  const [days, setDays] = useState(30);
  const { stats, error, off } = useStats(days);
  if (error) return <StatusPanel title="Не удалось загрузить">{error}</StatusPanel>;
  if (!stats)
    return (
      <p className="sessions-muted" role="status">
        Загружаем…
      </p>
    );
  if (off) return <SessionsOff />;
  return (
    <>
      <div className="sessions-filters">
        <PeriodChoice days={days} onChange={setDays} />
      </div>
      <SecretsSummary stats={stats} />
      <section className="sessions-card">
        <h2>Секреты по отпечаткам</h2>
        <p className="sessions-muted">
          Отпечаток — ключевой хеш значения: один и тот же секрет в разных сессиях даёт один отпечаток, а само значение
          на Полку не попадает. Начните с отправленных в сеть: такой секрет стоит отозвать.
        </p>
        <FingerprintTable fingerprints={stats.fingerprints} />
      </section>
    </>
  );
}

function UsagePage() {
  const [days, setDays] = useState(30);
  const { stats, error, off } = useStats(days);
  if (error) return <StatusPanel title="Не удалось загрузить">{error}</StatusPanel>;
  if (!stats)
    return (
      <p className="sessions-muted" role="status">
        Загружаем…
      </p>
    );
  if (off) return <SessionsOff />;
  return (
    <>
      <div className="sessions-filters">
        <PeriodChoice days={days} onChange={setDays} />
      </div>
      <UsageView stats={stats} />
    </>
  );
}

const TRANSCRIPT_PAGE = 200;

function Transcript({ id, hasTranscript }: { id: string; hasTranscript: boolean }) {
  const [events, setEvents] = useState<TranscriptEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [tooLarge, setTooLarge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async (offset: number) => {
    setBusy(true);
    setError("");
    try {
      const page = await sessionsApi.transcript(id, offset, TRANSCRIPT_PAGE);
      setEvents((was) => [...(offset ? (was ?? []) : []), ...page.events]);
      setTotal(page.total);
      setTooLarge(page.tooLarge);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  if (!hasTranscript) return <p className="sessions-muted">Расшифровка ещё не загружена.</p>;
  return (
    <>
      <div className="sessions-actions">
        {events === null && (
          <Button busy={busy} onClick={() => void load(0)}>
            Показать расшифровку
          </Button>
        )}
        <LinkButton href={transcriptUrl(id)} download>
          <Download /> Скачать расшифровку
        </LinkButton>
      </div>
      <ErrorNotice error={error} />
      {tooLarge && <p className="sessions-muted">Расшифровка слишком большая для страницы — скачайте её файлом.</p>}
      {events && (
        <>
          <p className="sessions-muted">
            Секреты в тексте заменены метками <code>[REDACTED:тип:отпечаток]</code>, длинный вывод инструментов
            сокращён. Показано {events.length} из {total}.
          </p>
          <TranscriptEvents events={events} />
          {events.length < total && (
            <Button busy={busy} onClick={() => void load(events.length)}>
              Ещё {Math.min(TRANSCRIPT_PAGE, total - events.length)}
            </Button>
          )}
        </>
      )}
    </>
  );
}

function SessionPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<{ missing: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  useEffect(() => {
    sessionsApi
      .get(id)
      .then(setDetail)
      .catch((e) => setError({ missing: e instanceof ApiError && e.status === 404, text: message(e) }));
  }, [id]);
  if (error)
    return (
      <StatusPanel
        title={error.missing ? "Сессия не найдена" : "Не удалось загрузить сессию"}
        action={<LinkButton href="/sessions">К сессиям</LinkButton>}
      >
        {error.missing ? "Её удалили, или она принадлежит другому человеку." : error.text}
      </StatusPanel>
    );
  if (!detail)
    return (
      <p className="sessions-muted" role="status">
        Загружаем…
      </p>
    );
  const { session } = detail;
  const remove = async () => {
    setBusy(true);
    setRemoveError("");
    try {
      await sessionsApi.remove(id);
      location.assign("/sessions");
    } catch (e) {
      setRemoveError(message(e));
      setBusy(false);
    }
  };
  return (
    <>
      <div className="sessions-head-row">
        <a className="sessions-back" href="/sessions">
          <ArrowLeft aria-hidden="true" /> Все сессии
        </a>
        <SecretsBadge status={session.secretsStatus} />
      </div>
      <h2 className="sessions-title">
        {session.projectLabel ?? "Без проекта"} · {SOURCE_LABEL[session.source]} · {formatWhen(session.startedAt)}
      </h2>
      <AlertList alerts={session.alerts} />
      <section className="sessions-card">
        <SessionFacts session={session} />
      </section>
      {detail.links.length > 0 && (
        <section className="sessions-card">
          <h2>Результаты</h2>
          <LinkList links={detail.links} />
        </section>
      )}
      <section className="sessions-card">
        <h2>Секреты · {detail.secrets.length}</h2>
        <SecretsTable secrets={detail.secrets} />
      </section>
      <section className="sessions-card">
        <h2>Что делал агент · {plural(session.toolCallCount, "вызов", "вызова", "вызовов")}</h2>
        {session.toolCallCount > detail.toolCalls.length && (
          <p className="sessions-muted">Сохранены первые {detail.toolCalls.length} вызовов.</p>
        )}
        <ToolCallList calls={detail.toolCalls} />
      </section>
      <section className="sessions-card">
        <h2>Расшифровка</h2>
        <Transcript id={id} hasTranscript={session.transcriptBytes > 0} />
      </section>
      <div className="sessions-actions">
        <Button variant="danger" onClick={() => setConfirm(true)}>
          <Trash2 /> Удалить сессию
        </Button>
      </div>
      {confirm && (
        <Dialog title="Удалить сессию?" busy={busy} onClose={() => !busy && setConfirm(false)}>
          <div className="dialog-body">
            <p>
              Сессия, её расшифровка и отчёт о секретах удалятся с Полки. Файл сессии на вашем компьютере останется:
              программа <code>polka-sessions</code> снова отправит его, если он изменится.
            </p>
            <ErrorNotice error={removeError} />
          </div>
          <div className="dialog-footer">
            <Button onClick={() => setConfirm(false)} disabled={busy}>
              Отмена
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void remove()}>
              Удалить
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function AgentSessions() {
  const account = useAccount();
  const route = sessionsRoute(location.pathname);
  useEffect(() => {
    if (account === null) location.assign(`/signin?next=${encodeURIComponent(location.pathname)}`);
  }, [account]);
  return (
    <AppShell current="sessions" account={account}>
      <main className="sessions-page">
        <header>
          <span className="eyebrow">Claude Code и Codex</span>
          <h1>Сессии агентов</h1>
        </header>
        {route.view !== "session" && <SessionsTabs current={route.view} />}
        {account &&
          (route.view === "session" ? (
            <SessionPage id={route.id} />
          ) : route.view === "secrets" ? (
            <SecretsView />
          ) : route.view === "usage" ? (
            <UsagePage />
          ) : (
            <SessionsList />
          ))}
      </main>
    </AppShell>
  );
}
