import "./styles.css";
import "../../features/recipient-convert/styles.css";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import React, { useEffect, useId, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Compass,
  Flag,
  Hourglass,
  Ban,
  Info,
  LockKeyhole,
  Maximize2,
  MessageCircle,
  TriangleAlert,
  UserRound,
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
import {
  SHARE_RETURN_PATH,
  takeShareAfterSignIn,
} from "../../shared/lib/share-return.ts";
import {
  useCapabilities,
  useSourceUrl,
} from "../../entities/capabilities/useCapabilities.ts";
import { ProviderButtons } from "../../features/provider-sign-in/index.tsx";
import {
  ConvertBar,
  ConvertCard,
  SignedInFromShare,
  leaveForProvider,
  useRecipientConvert,
} from "../../features/recipient-convert/index.tsx";

import { isFreshAccount } from "../../entities/recipient-convert/fresh-account.ts";
import { recipientNote } from "../../entities/recipient-note/copy.ts";

const accessRequest =
  "Привет! Ссылка на твою работу на Полке у меня не открывается — возможно, её отозвали или истёк срок. Пришлёшь новую?";

/** «Unavailable» is the link's answer; a network or server failure is not, and can be retried. */
type Failure = { kind: "unavailable" | "unreachable" | "signIn"; message: string } | null;

/**
 * The comments rail (COMMENTS.md, stage 3) plugs in here: the top bar shows
 * «💬 N» only when a count is given; `panel` is rendered in the right rail on
 * wide screens and in the bottom sheet on phones while `open`.
 */
export type CommentsSlot = {
  /** «Комментарии» or, with owner notes, «Заметки автора». */
  label?: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  panel?: React.ReactNode;
};

/**
 * A reader who left to sign in (to comment, or for a shelf of their own)
 * comes back to the same link; `returned` remembers that this load is that
 * return, so the page can say the shelf is ready.
 */
let returned = false;
function initialToken() {
  if (location.hash.length > 1) return location.hash.slice(1);
  const kept = takeShareAfterSignIn();
  if (kept) {
    history.replaceState(null, "", `/s#${kept}`);
    returned = true;
  }
  return kept ?? "";
}

export function Recipient() {
  const [token, setToken] = useState(initialToken);
  const [cameBack] = useState(() => returned);
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
          // An installation's link policy (docs/specs/EXTENSIONS.md): employees
          // only, after signing in here.
          if (e instanceof ApiError && e.status === 401 && e.details?.reason === "sign_in_required") {
            setError({ kind: "signIn", message: e.message });
            return;
          }
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
    !!viewer &&
    !("review" in viewer) &&
    !("blocked" in viewer) &&
    viewer.publisher === "user";
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
        returned={cameBack}
        onRetry={() => setAttempt((value) => value + 1)}
        comments={
          commentable && comments.available
            ? {
                label: comments.label,
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
  returned = false,
  onRetry,
  comments,
  overlay,
}: {
  viewer: Resolved | null;
  error: Failure;
  token: string;
  /** This load is the return from a sign-in that started on this link. */
  returned?: boolean;
  onRetry: () => void;
  comments?: CommentsSlot;
  /** The comment overlay in the document's frame (see useSharedComments). */
  overlay?: FrameOverlay;
}) {
  const account = useAccount();
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const underReview = !!resolved && "review" in resolved;
  const blocked = !!resolved && "blocked" in resolved;
  const viewer: Viewer | null =
    resolved && !("review" in resolved) && !("blocked" in resolved)
      ? resolved
      : null;
  const plainText = viewer?.revision.mime === "text/plain";
  // The way in for a guest (features/recipient-convert): only once /session
  // has said «guest», and only when a work is actually shown.
  const guest = account === null;
  const convert = useRecipientConvert({ enabled: guest && viewer !== null });
  const capabilities = useCapabilities();
  const yandex =
    capabilities.status === "ready"
      ? capabilities.capabilities.signInProviders.filter((p) => p.id === "yandex")
      : [];
  const [welcome, setWelcome] = useState(returned);
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
  // The work alone on the screen: no bars, no navigation (Esc returns).
  const fullscreen =
    typeof document !== "undefined" && document.fullscreenEnabled ? (
      <Button
        variant="quiet"
        className="recipient-fullscreen"
        aria-label="На весь экран"
        title="На весь экран"
        onClick={() => void convert.stageRef.current?.requestFullscreen?.()}
      >
        <Maximize2 /> <span>На весь экран</span>
      </Button>
    ) : null;
  if (error?.kind === "signIn")
    return (
      <RecipientFrame account={account}>
        <main className="empty recipient-denied">
          <div className="empty-icon"><LockKeyhole /></div>
          <h1>Войдите, чтобы открыть</h1>
          <p role="alert">{error.message}</p>
          <p>
            Войдите в Полку в новой вкладке, затем вернитесь сюда и откройте работу снова. Ссылку
            при этом копировать не нужно.
          </p>
          <div className="button-row">
            <a className="ui-button ui-button--primary" href="/signin" target="_blank" rel="noopener">
              Войти
            </a>
            <Button onClick={onRetry}>Я вошёл — открыть</Button>
          </div>
        </main>
      </RecipientFrame>
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
  if (blocked)
    // Blocked by the moderator or the content filter: nothing about the work.
    return (
      <RecipientFrame account={account}>
        <main className="empty recipient-denied recipient-review">
          <div className="empty-icon"><Ban /></div>
          <h1>Ссылка недоступна</h1>
          <p>
            Модератор Полки закрыл доступ по этой ссылке. Содержимое не
            показывается.
          </p>
          <a className="recipient-explore" href="/">
            Что такое Полка <ArrowUpRight size={15} />
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
  const card = convert.card;
  return (
    <RecipientFrame
      account={account}
      title={viewer.title}
      // Plain text is set as an article with its own h1; the bar repeats it quietly.
      titleAsHeading={!plainText}
      actions={
        <>
          {kind !== "text" && fullscreen}
          {report}
        </>
      }
      note={<AboutThisPage viewer={viewer} />}
      comments={comments}
      kind={kind}
      stageRef={convert.stageRef}
      banner={
        welcome && account ? (
          <SignedInFromShare
            created={isFreshAccount(account)}
            origin={location.origin}
            onClose={() => setWelcome(false)}
          />
        ) : undefined
      }
      footer={
        guest ? (
          <ConvertBar
            onTry={(opener) => convert.press("try", opener)}
            onRemix={(opener) => convert.press("remix", opener)}
          />
        ) : undefined
      }
      floating={
        guest && card ? (
          <ConvertCard
            variant={card.variant}
            origin={location.origin}
            revision={viewer.revision}
            back={{ token }}
            signIn={
              yandex.length ? (
                <ProviderButtons
                  providers={yandex}
                  next={SHARE_RETURN_PATH}
                  onLeave={() => leaveForProvider({ token }, card.variant)}
                />
              ) : undefined
            }
            onClose={convert.close}
          />
        ) : undefined
      }
    >
      <Preview
        revision={viewer.revision}
        grant={viewer.grant}
        title={viewer.title}
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
 * keeps the shell with its rail folded. Either way the work fills the rest of the viewport under a
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
  stageRef,
  banner,
  footer,
  floating,
  children,
}: {
  account: Account | null | undefined;
  title?: string;
  titleAsHeading?: boolean;
  actions?: React.ReactNode;
  note?: React.ReactNode;
  comments?: CommentsSlot;
  kind?: "page" | "image" | "text";
  /** The element holding the work (the convert card watches it for a first touch). */
  stageRef?: React.MutableRefObject<HTMLElement | null>;
  /** Under the top bar: the note after a sign-up. */
  banner?: React.ReactNode;
  /** Under the work, in the flow: the guest's bar. The stage shrinks by its height. */
  footer?: React.ReactNode;
  /** Above everything, positioned by itself: the convert card. */
  floating?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Until /me answers, the page is laid out for a guest: no navigation flashes in.
  const guest = !account;
  const railId = "recipient-comments";
  const Title = titleAsHeading ? "h1" : "p";
  // The card floats above the footer: its height goes into a CSS variable.
  const frame = useRef<HTMLDivElement>(null);
  const footerBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = footerBox.current;
    const host = frame.current;
    if (!host) return;
    if (!node || typeof ResizeObserver === "undefined") {
      host.style.removeProperty("--convert-bar-height");
      return;
    }
    const measure = () =>
      host.style.setProperty("--convert-bar-height", `${node.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [footer !== undefined]);
  return (
    <AppShell
      current="shelf"
      account={account}
      bare={guest}
      // A signed-in viewer keeps the app, folded to icons: the work comes first.
      foldableRail
      className="recipient recipient-reader"
    >
      <div ref={frame} className="recipient-frame" data-guest={guest || undefined}>
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
                    aria-label={`${comments.label ?? "Комментарии"}: ${comments.count}`}
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
        {banner}
        <div className="recipient-body">
          {kind ? (
            <main
              ref={(node) => {
                if (stageRef) stageRef.current = node;
              }}
              className="recipient-stage"
              data-kind={kind}
            >
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
              aria-label={comments.label ?? "Комментарии"}
            >
              {comments.panel}
            </aside>
          )}
        </div>
        {footer && (
          <div ref={footerBox} className="recipient-footer">
            {footer}
          </div>
        )}
        {floating}
      </div>
    </AppShell>
  );
}

/** One line always in view; the full text and provenance behind «Подробнее». */
function AboutThisPage({ viewer }: { viewer: Viewer }) {
  const [open, setOpen] = useState(false);
  const sourceUrl = useSourceUrl();
  const detailsId = useId();
  const note = recipientNote(viewer);
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
      data-tone={note.tone}
      role="note"
      aria-label="Об этой странице"
    >
      <p className="recipient-note-line">
        {note.tone === "editorial" ? (
          <BookOpen aria-hidden="true" />
        ) : note.tone === "quiet" ? (
          <UserRound aria-hidden="true" />
        ) : (
          <TriangleAlert aria-hidden="true" />
        )}
        <span>{note.line}</span>
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
        <p>
          {note.details}
          {note.tone !== "editorial" && viewer.authorIsNew && (
            <>
              {" "}
              <strong>Автор недавно на Полке.</strong>
            </>
          )}
        </p>
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
