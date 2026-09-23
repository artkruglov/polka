import "./styles.css";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import React, { useEffect, useId, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Compass,
  Flag,
  Hourglass,
  Info,
  LockKeyhole,
  MessageCircle,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import type {
  Account,
  Resolved,
  Viewer,
} from "../../../../../packages/contracts/index.ts";
import { ApiError, client } from "../../shared/api/client.ts";
import { dateTime, kindOf, profileView } from "../../entities/artifact/format.ts";
import { Button } from "../../shared/ui/controls.tsx";
import { ReportArtifactPanel } from "../../features/report-artifact/index.tsx";
import {
  Preview,
  type FrameOverlay,
} from "../../widgets/artifact-preview/index.ts";
import { CopyText } from "../../shared/ui/CopyText.tsx";
import { useSharedComments } from "../../widgets/comments/index.ts";
import { takeShareAfterSignIn } from "../../shared/lib/share-return.ts";
import { useSourceUrl } from "../../entities/capabilities/useCapabilities.ts";

const accessRequest =
  "Привет! Ссылка на твою работу на Полке у меня не открывается — возможно, её отозвали или истёк срок. Пришлёшь новую?";

/** «Unavailable» is the link's answer; a network or server failure is not, and can be retried. */
type Failure = { kind: "unavailable" | "unreachable"; message: string } | null;

/**
 * The comments rail (COMMENTS.md, stage 3) plugs in here: the top bar shows
 * «💬 N» only when a count is given; `panel` is rendered in the right rail on
 * wide screens and in the bottom sheet on phones while `open`.
 */
export type CommentsSlot = {
  count: number;
  open: boolean;
  onToggle: () => void;
  panel?: React.ReactNode;
};

/** A reader who left to sign in (to comment) comes back to the same link. */
function initialToken() {
  if (location.hash.length > 1) return location.hash.slice(1);
  const kept = takeShareAfterSignIn();
  if (kept) history.replaceState(null, "", `/s#${kept}`);
  return kept ?? "";
}

export function Recipient() {
  const [token, setToken] = useState(initialToken);
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
  // Comments belong to user links; editorial pages have none.
  const commentable =
    !!viewer && !("review" in viewer) && viewer.publisher === "user";
  const [reportComment, setReportComment] = useState<string | null>(null);
  const comments = useSharedComments({
    token,
    enabled: commentable,
    onReport: setReportComment,
  });
  return (
    <>
      <RecipientScreen
        key={token}
        viewer={viewer}
        error={error}
        token={token}
        onRetry={() => setAttempt((value) => value + 1)}
        comments={
          commentable && comments.available
            ? {
                count: comments.count,
                open: comments.open,
                onToggle: comments.onToggle,
                panel: comments.panel,
              }
            : undefined
        }
        overlay={commentable && comments.available ? comments.overlay : undefined}
      />
      {commentable && comments.floating}
      {reportComment && (
        <ReportArtifactPanel
          token={token}
          commentId={reportComment}
          onClose={() => setReportComment(null)}
          onSent={() => setReportComment(null)}
        />
      )}
    </>
  );
}

/** What a link opens: the fixed version, its provenance, and a way to report it. */
export function RecipientScreen({
  viewer: resolved,
  error,
  token,
  onRetry,
  comments,
  overlay,
}: {
  viewer: Resolved | null;
  error: Failure;
  token: string;
  onRetry: () => void;
  comments?: CommentsSlot;
  /** The comment overlay in the document's frame (see useSharedComments). */
  overlay?: FrameOverlay;
}) {
  const account = useAccount();
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const underReview = !!resolved && "review" in resolved;
  const viewer: Viewer | null =
    resolved && !("review" in resolved) ? resolved : null;
  const plainText = viewer?.revision.mime === "text/plain";
  const report = reported ? (
    <span className="report-sent">Жалоба отправлена</span>
  ) : (
    <Button
      variant="quiet"
      className="report-button"
      aria-label="Пожаловаться"
      title="Пожаловаться"
      onClick={() => setReporting(true)}
    >
      <Flag /> <span>Пожаловаться</span>
    </Button>
  );
  if (error?.kind === "unreachable")
    return (
      <RecipientFrame account={account}>
        <main className="empty recipient-denied">
          <div className="empty-icon"><WifiOff /></div>
          <h1>Не удалось открыть работу</h1>
          <p role="alert">{error.message}</p>
          <Button variant="primary" onClick={onRetry}>
            Повторить
          </Button>
        </main>
      </RecipientFrame>
    );
  if (error)
    return (
      <RecipientFrame account={account}>
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
      </RecipientFrame>
    );
  if (underReview)
    // Held for review or paused after reports: no title, no content.
    return (
      <RecipientFrame account={account}>
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
      </RecipientFrame>
    );
  if (!viewer)
    return (
      <RecipientFrame account={account}>
        <main className="empty" role="status">
          Открываем работу…
        </main>
      </RecipientFrame>
    );
  const kind = plainText
    ? "text"
    : viewer.revision.mime.startsWith("image/")
      ? "image"
      : "page";
  return (
    <RecipientFrame
      account={account}
      title={viewer.title}
      // Plain text is set as an article with its own h1; the bar repeats it quietly.
      titleAsHeading={!plainText}
      actions={report}
      note={<AboutThisPage viewer={viewer} />}
      comments={comments}
      kind={kind}
    >
      <Preview
        revision={viewer.revision}
        grant={viewer.grant}
        readingTitle={plainText ? viewer.title : undefined}
        overlay={overlay}
      />
      {reporting && (
        <ReportArtifactPanel
          token={token}
          onClose={() => setReporting(false)}
          onSent={() => setReported(true)}
        />
      )}
    </RecipientFrame>
  );
}

/**
 * Document first. A guest gets no app navigation at all; a signed-in viewer
 * keeps the shell. Either way the work fills the rest of the viewport under a
 * thin bar: title and actions, then the one-line note about the page.
 */
function RecipientFrame({
  account,
  title,
  titleAsHeading = true,
  actions,
  note,
  comments,
  kind,
  children,
}: {
  account: Account | null | undefined;
  title?: string;
  titleAsHeading?: boolean;
  actions?: React.ReactNode;
  note?: React.ReactNode;
  comments?: CommentsSlot;
  kind?: "page" | "image" | "text";
  children: React.ReactNode;
}) {
  // Until /me answers, the page is laid out for a guest: no navigation flashes in.
  const guest = !account;
  const railId = "recipient-comments";
  const Title = titleAsHeading ? "h1" : "p";
  return (
    <AppShell
      current="shelf"
      account={account}
      bare={guest}
      className="recipient recipient-reader"
    >
      <div className="recipient-frame" data-guest={guest || undefined}>
        <header className="recipient-topbar">
          {(title || actions || comments) && (
            <div className="recipient-topbar-row">
              {title ? (
                <Title className="recipient-title" title={title}>
                  {title}
                </Title>
              ) : (
                <span className="recipient-title" />
              )}
              <div className="recipient-topbar-actions">
                {comments && (
                  <Button
                    variant="quiet"
                    className="recipient-comments-toggle"
                    aria-pressed={comments.open}
                    aria-controls={railId}
                    aria-label={`Комментарии: ${comments.count}`}
                    onClick={comments.onToggle}
                  >
                    <MessageCircle /> <span>{comments.count}</span>
                  </Button>
                )}
                {actions}
              </div>
            </div>
          )}
          <div className="recipient-topbar-row recipient-topbar-row--note">
            {note}
            <a className="recipient-made" href="/">
              Сделано на Полке
            </a>
          </div>
        </header>
        <div className="recipient-body">
          {kind ? (
            <main className="recipient-stage" data-kind={kind}>
              {children}
            </main>
          ) : (
            children
          )}
          {/* Comments rail (stage 3): a right column on wide screens, a bottom sheet on phones. */}
          {comments?.open && (
            <aside
              id={railId}
              className="recipient-comments"
              aria-label="Комментарии"
            >
              {comments.panel}
            </aside>
          )}
        </div>
      </div>
    </AppShell>
  );
}

/** One line always in view; the full text and provenance behind «Подробнее». */
function AboutThisPage({ viewer }: { viewer: Viewer }) {
  const [open, setOpen] = useState(false);
  const sourceUrl = useSourceUrl();
  const detailsId = useId();
  const editorial = viewer.publisher === "editorial";
  const meta = [
    "Открыто по ссылке",
    kindOf(viewer.revision),
    dateTime(viewer.revision.createdAt),
    viewer.revision.mime === "text/html"
      ? viewer.revision.inlineBuild?.state === "ready"
        ? "Интерактивная версия"
        : viewer.revision.htmlProfile === "limited"
          ? "Статичный просмотр · интерактивные действия отключены"
          : profileView(viewer.revision).badge
      : null,
  ].filter(Boolean);
  return (
    <div
      className="recipient-note"
      data-tone={editorial ? "editorial" : "warning"}
      role="note"
      aria-label="Об этой странице"
    >
      <p className="recipient-note-line">
        {editorial ? (
          <>
            <BookOpen aria-hidden="true" />
            <span>Редакция Полки</span>
          </>
        ) : (
          <>
            <TriangleAlert aria-hidden="true" />
            <span>
              Страница пользователя Полки, не проверена. Не вводите здесь
              пароли, коды из SMS и данные карт.
            </span>
          </>
        )}
        <button
          type="button"
          className="recipient-note-more"
          aria-label={open ? "Скрыть подробности" : "Подробнее об этой странице"}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((value) => !value)}
        >
          <Info aria-hidden="true" />
          <span>{open ? "Скрыть" : "Подробнее"}</span>
        </button>
      </p>
      <div id={detailsId} className="recipient-note-details" hidden={!open}>
        {editorial ? (
          <p>Эту страницу подготовила редакция Полки.</p>
        ) : (
          <p>
            Эту страницу опубликовал пользователь Полки. Полка её не
            проверяла. Не вводите здесь пароли, коды из SMS и данные карт.
            {viewer.authorIsNew && (
              <>
                {" "}
                <strong>Автор недавно на Полке.</strong>
              </>
            )}
          </p>
        )}
        <p>
          {meta.join(" · ")}. Сохранённая версия зафиксирована; владелец может
          обновить или отозвать ссылку. Аккаунт в исходном сервисе не нужен.
        </p>
        <nav className="recipient-note-links" aria-label="О Полке">
          <a href="/">
            Что такое Полка <ArrowUpRight size={13} />
          </a>
          <a href="/privacy">Политика</a>
          <a href="/terms">Соглашение</a>
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
            Открытый код
          </a>
        </nav>
      </div>
    </div>
  );
}
