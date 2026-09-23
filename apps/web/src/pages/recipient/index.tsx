import "./styles.css";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import React, { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Compass,
  Flag,
  Hourglass,
  Link as LinkIcon,
  LockKeyhole,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import type {
  Resolved,
  Viewer,
} from "../../../../../packages/contracts/index.ts";
import { ApiError, client } from "../../shared/api/client.ts";
import { dateTime, kindOf, profileView } from "../../entities/artifact/format.ts";
import { Button, Badge } from "../../shared/ui/controls.tsx";
import { ReportArtifactPanel } from "../../features/report-artifact/index.tsx";
import { Preview } from "../../widgets/artifact-preview/index.ts";
import { CopyText } from "../../shared/ui/CopyText.tsx";

const accessRequest =
  "Привет! Ссылка на твою работу на Полке у меня не открывается — возможно, её отозвали или истёк срок. Пришлёшь новую?";

/** «Unavailable» is the link's answer; a network or server failure is not, and can be retried. */
type Failure = { kind: "unavailable" | "unreachable"; message: string } | null;

export function Recipient() {
  const [token, setToken] = useState(() => location.hash.slice(1));
  const [viewer, setViewer] = useState<Resolved | null>(null);
  const [error, setError] = useState<Failure>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const load = () => {
      const nextToken = location.hash.slice(1);
      const requestGeneration = ++generation;
      setToken(nextToken);
      setViewer(null);
      setError(null);
      client
        .resolve(nextToken)
        .then((nextViewer) => {
          if (active && requestGeneration === generation) setViewer(nextViewer);
        })
        .catch((e) => {
          if (!active || requestGeneration !== generation) return;
          const unreachable =
            !(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500;
          setError(
            unreachable
              ? {
                  kind: "unreachable",
                  message:
                    e instanceof ApiError && e.status === 429
                      ? "Слишком много открытий подряд. Подождите немного и повторите."
                      : "Полка сейчас не отвечает. Ссылка при этом может быть рабочей.",
                }
              : { kind: "unavailable", message: "Работа по этой ссылке недоступна" },
          );
        });
    };
    load();
    window.addEventListener("hashchange", load);
    return () => {
      active = false;
      window.removeEventListener("hashchange", load);
    };
  }, [attempt]);
  return (
    <RecipientScreen
      key={token}
      viewer={viewer}
      error={error}
      token={token}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

/** What a link opens: the fixed version, its provenance, and a way to report it. */
function RecipientScreen({
  viewer: resolved,
  error,
  token,
  onRetry,
}: {
  viewer: Resolved | null;
  error: Failure;
  token: string;
  onRetry: () => void;
}) {
  const account = useAccount();
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const underReview = !!resolved && "review" in resolved;
  const viewer: Viewer | null =
    resolved && !("review" in resolved) ? resolved : null;
  const plainText = viewer?.revision.mime === "text/plain";
  return (
    <AppShell
      current="shelf"
      account={account}
      className="recipient recipient-reader"
    >
      {error?.kind === "unreachable" ? (
        <main className="empty recipient-denied">
          <div className="empty-icon"><WifiOff /></div>
          <h1>Не удалось открыть работу</h1>
          <p role="alert">{error.message}</p>
          <Button variant="primary" onClick={onRetry}>
            Повторить
          </Button>
        </main>
      ) : error ? (
        <main className="empty recipient-denied">
          <div className="empty-icon"><LockKeyhole /></div>
          <h1>{error.message}</h1>
          <p>
            Владелец мог отозвать ссылку, у неё мог истечь срок, или адрес
            скопирован не полностью. Мы не показываем, была ли здесь работа.
          </p>
          <div className="recipient-request">
            <strong>Запросить новую ссылку у владельца</strong>
            <small>
              Полка не знает, кто прислал вам ссылку. Отправьте владельцу это
              сообщение там, где получили ссылку.
            </small>
            <CopyText
              value={accessRequest}
              label="Сообщение владельцу"
              rows={3}
            />
          </div>
          <a className="recipient-explore" href="/discover">
            <Compass /> Посмотреть публичные примеры
          </a>
        </main>
      ) : underReview ? (
        // Held for review or paused after reports: no title, no content.
        <main className="empty recipient-denied recipient-review">
          <div className="empty-icon"><Hourglass /></div>
          <h1>Ссылка на проверке у модератора Полки</h1>
          <p>
            Полка проверяет некоторые ссылки, прежде чем их откроют: новые
            аккаунты, страницы, похожие на поддельные, и ссылки с жалобами.
            Если проверка пройдёт, работа откроется по этой же ссылке.
          </p>
          <p className="recipient-review-hint">
            Загляните позже или спросите у того, кто прислал ссылку.
          </p>
          <a className="recipient-explore" href="/">
            Что такое Полка <ArrowUpRight size={15} />
          </a>
        </main>
      ) : viewer ? (
        <main className="recipient-main">
          <div className="recipient-bar">
            <Badge tone="accent">
              <LinkIcon /> Открыто по ссылке
            </Badge>
            <span>
              {kindOf(viewer.revision)} · {dateTime(viewer.revision.createdAt)}
            </span>
            {viewer.revision.mime === "text/html" && (
              <span
                className="recipient-reader-profile"
                data-profile={viewer.revision.htmlProfile ?? "file"}
              >
                {viewer.revision.inlineBuild?.state === "ready"
                  ? "Интерактивная версия"
                  : viewer.revision.htmlProfile === "limited"
                  ? "Статичный просмотр · интерактивные действия отключены"
                  : profileView(viewer.revision).badge}
              </span>
            )}
          </div>
          {viewer.publisher === "editorial" ? (
            <p className="recipient-notice recipient-notice--editorial">
              <BookOpen aria-hidden="true" />
              <span>Редакция Полки</span>
            </p>
          ) : (
            <aside
              className="recipient-notice"
              aria-label="Об этой странице"
            >
              <TriangleAlert aria-hidden="true" />
              <div className="recipient-notice-text">
                <p>
                  Эту страницу опубликовал пользователь Полки. Полка её не
                  проверяла. Не вводите здесь пароли, коды из SMS и данные
                  карт.
                </p>
                {viewer.authorIsNew && (
                  <small>Автор недавно на Полке.</small>
                )}
              </div>
              {reported ? (
                <span className="report-sent">Жалоба отправлена</span>
              ) : (
                <Button
                  variant="quiet"
                  className="report-button"
                  onClick={() => setReporting(true)}
                >
                  <Flag /> Пожаловаться
                </Button>
              )}
            </aside>
          )}
          {!plainText && (
            <header className="recipient-heading">
              <h1>{viewer.title}</h1>
            </header>
          )}
          <div className="stage" data-kind={plainText ? "text" : viewer.revision.mime.startsWith("image/") ? "image" : "page"}>
            <Preview
              revision={viewer.revision}
              grant={viewer.grant}
              readingTitle={plainText ? viewer.title : undefined}
            />
          </div>
          <footer className="recipient-reader-footer">
            <div className="recipient-reader-provenance">
              <p>
                Сохранённая версия зафиксирована. Владелец может обновить или
                отозвать ссылку.
              </p>
              <small>
                Копия с Полки · аккаунт в исходном сервисе не нужен.
              </small>
            </div>
            <div className="recipient-reader-footer-actions">
              <a href="/">
                Что такое Полка <ArrowUpRight size={15} />
              </a>
              {viewer.publisher === "editorial" &&
                (reported ? (
                  <span className="report-sent">Жалоба отправлена</span>
                ) : (
                  <Button
                    variant="quiet"
                    className="report-button"
                    onClick={() => setReporting(true)}
                  >
                    <Flag /> Пожаловаться
                  </Button>
                ))}
            </div>
          </footer>
          {reporting && (
            <ReportArtifactPanel
              token={token}
              onClose={() => setReporting(false)}
              onSent={() => setReported(true)}
            />
          )}
        </main>
      ) : (
        <main className="empty" role="status">
          Открываем работу…
        </main>
      )}
    </AppShell>
  );
}
