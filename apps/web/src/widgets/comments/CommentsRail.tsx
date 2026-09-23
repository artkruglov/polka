import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  CornerDownRight,
  Flag,
  LogIn,
  MessageSquarePlus,
  RotateCcw,
  SmilePlus,
  Trash2,
  X,
} from "lucide-react";
import {
  COMMENT_MAX_CHARS,
  REACTIONS,
  type CommentAnchor,
  type CommentThread,
  type CommentView,
  type CommentViewer,
  type Reaction,
  type ReactionGroup,
  type ShareDiscussion,
} from "../../../../../packages/contracts/comments.ts";
import { dateTime } from "../../entities/artifact/format.ts";
import { Button } from "../../shared/ui/controls.tsx";
import type { BridgeAnchor, OverlayBridge } from "./bridge.ts";

import type { DiscussionActions } from "./useDiscussion.ts";

/**
 * The discussion of one link beside the document. On a wide screen, while
 * the overlay reports where the fragments are, each card sits at the height
 * of its fragment (pushed down when cards would overlap); otherwise, and in
 * the phone's bottom sheet, cards follow the document's order.
 *
 * Comment text is plain text: React renders it as text, never as markup, and
 * an address in it is not a link.
 */

export type PendingComment = { anchor: CommentAnchor | null } | null;

/**
 * Everyone with the link sees the name under a comment: until the person
 * chose it, the first comment asks for it (prefilled, editable).
 */
const NameChoice = createContext<{ needed: boolean; suggested: string }>({
  needed: false,
  suggested: "",
});

export type CommentSettings = { displayName?: string; commentMail?: boolean };

type Props = {
  discussion: ShareDiscussion;
  signedIn: boolean;
  actions: DiscussionActions;
  bridge?: OverlayBridge;
  /** A comment being written: on a fragment, or on the whole work. */
  pending: PendingComment;
  onPendingChange: (pending: PendingComment) => void;
  onSignIn?: () => void;
  onReport?: (commentId: string) => void;
  layout: "rail" | "sheet";
  /** Above the threads: the owner's link picker, unread counter. */
  header?: React.ReactNode;
  onClose?: () => void;
  /** Closed link: read, resolve, delete; no new comments. */
  readOnly?: boolean;
  viewer?: CommentViewer;
  onSettings?: (settings: CommentSettings) => Promise<void>;
};

type Item =
  | { key: string; kind: "composer"; anchor: CommentAnchor | null }
  | { key: string; kind: "thread"; thread: CommentThread }
  | { key: string; kind: "reactions"; sig: string; anchor: CommentAnchor; groups: ReactionGroup[] };

const GAP = 8;

/**
 * The quotes the overlay paints: open threads and reactions on fragments no
 * open thread quotes. Sent whether or not the rail is open.
 */
export function anchorsOf(discussion: ShareDiscussion): BridgeAnchor[] {
  const open = discussion.threads.filter(
    (thread) => !thread.resolvedAt && thread.anchor && !thread.deleted,
  );
  const quoted = new Set(open.map((thread) => thread.sig));
  const fragments = new Map<string, BridgeAnchor>();
  for (const group of discussion.reactions)
    if (group.sig && group.anchor && !quoted.has(group.sig))
      fragments.set(group.sig, { id: `r:${group.sig}`, ...group.anchor });
  return [
    ...open.map((thread) => ({ id: thread.id, ...thread.anchor! })),
    ...fragments.values(),
  ];
}
const quote = (text: string, max = 140) => {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

export function CommentsRail({
  discussion,
  signedIn,
  actions,
  bridge,
  pending,
  onPendingChange,
  onSignIn,
  onReport,
  layout,
  header,
  onClose,
  readOnly = false,
  viewer,
  onSettings,
}: Props) {
  const [showResolved, setShowResolved] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState("");
  const state = bridge?.state;
  const resolvedCount = discussion.threads.filter((t) => t.resolvedAt).length;
  const threads = discussion.threads.filter(
    (thread) => showResolved || !thread.resolvedAt,
  );
  // Reactions on a fragment no thread quotes get their own small card.
  const threadSigs = new Set(threads.map((thread) => thread.sig));
  const bySig = new Map<string, ReactionGroup[]>();
  for (const group of discussion.reactions)
    if (group.sig && group.anchor && !threadSigs.has(group.sig))
      bySig.set(group.sig, [...(bySig.get(group.sig) ?? []), group]);
  const fragmentReactions = [...bySig.entries()];
  const workReactions = discussion.reactions.filter((group) => !group.sig);

  useEffect(() => {
    bridge?.setActive(active);
  });
  // A click on a highlight in the document selects its card.
  const cardRefs = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (!state?.focus) return;
    setActive(state.focus.id);
    cardRefs.current
      .get(state.focus.id)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [state?.focus]);

  const positionOf = (id: string) =>
    state?.ready && !state.missing.has(id) ? state.positions[id] : undefined;
  const items: Item[] = [
    ...(pending && !readOnly
      ? [{ key: "composer", kind: "composer" as const, anchor: pending.anchor }]
      : []),
    ...threads.map((thread) => ({
      key: thread.id,
      kind: "thread" as const,
      thread,
    })),
    ...fragmentReactions.map(([sig, groups]) => ({
      key: `r:${sig}`,
      kind: "reactions" as const,
      sig,
      anchor: groups[0]!.anchor!,
      groups,
    })),
  ];
  // Where each item belongs in the document; the composer follows the selection.
  const yOf = (item: Item): number | undefined => {
    if (item.kind === "composer")
      return undefined;
    if (item.kind === "thread")
      return item.thread.anchor ? positionOf(item.thread.id) : undefined;
    return positionOf(item.key);
  };
  const unplaced = items.filter((item) => yOf(item) === undefined);
  const placed = items
    .filter((item) => yOf(item) !== undefined)
    .sort((a, b) => yOf(a)! - yOf(b)!);
  const aligned =
    layout === "rail" && !!state?.ready && placed.length > 0 && !!bridge;

  // Aligned cards: measured after render, then placed at their fragment's
  // height, pushed down so none overlaps the one before. Items without a
  // place in the document (the composer, comments on the whole work) come
  // first. Cards never hide: when fragments crowd, the rail scrolls.
  const region = useRef<HTMLDivElement | null>(null);
  const [layout2, setLayout2] = useState<{ tops: Record<string, number>; height: number }>({
    tops: {},
    height: 0,
  });
  useLayoutEffect(() => {
    if (!aligned || !region.current || !bridge) return;
    const box = region.current.getBoundingClientRect();
    const frameTop = bridge.frameTop();
    if (frameTop === null) return;
    const offset = frameTop - box.top - (state?.scrollY ?? 0);
    let cursor = 0;
    const tops: Record<string, number> = {};
    for (const item of [...unplaced, ...placed]) {
      const height = cardRefs.current.get(item.key)?.offsetHeight ?? 96;
      const y = yOf(item);
      const top = Math.round(Math.max(y === undefined ? cursor : offset + y, cursor));
      tops[item.key] = top;
      cursor = top + height + GAP;
    }
    const changed =
      Math.abs(cursor - layout2.height) > 0.5 ||
      Object.keys(tops).length !== Object.keys(layout2.tops).length ||
      Object.entries(tops).some(
        ([key, top]) => Math.abs((layout2.tops[key] ?? -1e9) - top) > 0.5,
      );
    if (changed) setLayout2({ tops, height: cursor });
  });

  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
  const focusThread = (key: string) => {
    setActive(key);
    if (positionOf(key) !== undefined) bridge?.scrollTo(key);
  };
  const card = (item: Item, style?: React.CSSProperties) => {
    const ref = (element: HTMLElement | null) => {
      if (element) cardRefs.current.set(item.key, element);
      else cardRefs.current.delete(item.key);
    };
    if (item.kind === "composer")
      return (
        <Composer
          key={item.key}
          cardRef={ref}
          style={style}
          anchor={item.anchor}
          signedIn={signedIn}
          onSignIn={onSignIn}
          onCancel={() => onPendingChange(null)}
          onSubmit={async (body, displayName) => {
            await run(() =>
              actions.create({
                body,
                ...(item.anchor ? { anchor: item.anchor } : {}),
                ...(displayName ? { displayName } : {}),
              }),
            );
            onPendingChange(null);
            bridge?.clearSelection();
          }}
        />
      );
    if (item.kind === "reactions")
      return (
        <article
          key={item.key}
          ref={ref}
          style={style}
          className="comment-card comment-card--reactions"
          data-active={active === item.key || undefined}
          onClick={() => focusThread(item.key)}
        >
          <blockquote className="comment-quote">{quote(item.anchor.exact)}</blockquote>
          <ReactionChips
            groups={item.groups}
            disabled={!signedIn || readOnly}
            onToggle={(emoji) => run(() => actions.react(emoji, item.anchor))}
          />
        </article>
      );
    const thread = item.thread;
    const missing = !!thread.anchor && !!state?.ready && state.missing.has(thread.id);
    return (
      <ThreadCard
        key={item.key}
        cardRef={ref}
        style={style}
        thread={thread}
        reactions={thread.sig ? discussion.reactions.filter((g) => g.sig === thread.sig) : []}
        missing={
          missing
            ? thread.revisionId !== discussion.revisionId
              ? "К прежней версии"
              : "Фрагмент не найден"
            : null
        }
        active={active === thread.id}
        onActivate={() => focusThread(thread.id)}
        signedIn={signedIn}
        readOnly={readOnly}
        actions={actions}
        run={run}
        onReport={onReport}
        onSignIn={onSignIn}
      />
    );
  };

  const count = discussion.threads.filter((t) => !t.deleted).length;
  return (
    <NameChoice.Provider
      value={{
        needed: !!viewer?.signedIn && !viewer.nameChosen,
        suggested: viewer?.name ?? "",
      }}
    >
    <section className="comments" data-layout={layout} aria-label="Обсуждение">
      <header className="comments-head">
        <h2>
          Комментарии <span className="comments-count">{count}</span>
        </h2>
        {!readOnly && (
          <Button
            variant="quiet"
            className="comments-new"
            onClick={() => onPendingChange({ anchor: null })}
            title="Комментарий ко всей работе"
          >
            <MessageSquarePlus /> <span>Ко всей работе</span>
          </Button>
        )}
        {onClose && (
          <Button variant="quiet" className="comments-close" aria-label="Скрыть комментарии" onClick={onClose}>
            <X />
          </Button>
        )}
      </header>
      {header}
      {workReactions.length > 0 && (
        <div className="comments-work-reactions">
          <span>Работе целиком:</span>
          <ReactionChips
            groups={workReactions}
            disabled={!signedIn || readOnly}
            onToggle={(emoji) => run(() => actions.react(emoji, null))}
          />
        </div>
      )}
      {error && (
        <p className="comments-error" role="alert">
          {error}
        </p>
      )}
      {items.length === 0 && (
        <p className="comments-empty">
          {readOnly
            ? "Здесь пока нет комментариев."
            : state?.ready
              ? "Выделите фрагмент текста, чтобы прокомментировать его, или оставьте комментарий ко всей работе."
              : "Пока нет комментариев. Оставьте первый — ко всей работе."}
        </p>
      )}
      {aligned ? (
        <div
          className="comments-aligned"
          ref={region}
          style={{ height: layout2.height }}
        >
          {[...unplaced, ...placed].map((item) =>
            card(item, {
              position: "absolute",
              top: layout2.tops[item.key] ?? 0,
              left: 0,
              right: 0,
            }),
          )}
        </div>
      ) : (
        <div className="comments-list">
          {[...unplaced, ...placed].map((item) => card(item))}
        </div>
      )}
      {resolvedCount > 0 && (
        <button
          type="button"
          className="comments-resolved-toggle"
          onClick={() => setShowResolved((value) => !value)}
          aria-pressed={showResolved}
        >
          {showResolved ? "Скрыть решённые" : `Показать решённые (${resolvedCount})`}
        </button>
      )}
      {viewer?.signedIn && onSettings && (
        <Settings viewer={viewer} onSettings={(value) => run(() => onSettings(value))} />
      )}
    </section>
    </NameChoice.Provider>
  );
}

/** The name under one's comments and letters about them. */
function Settings({
  viewer,
  onSettings,
}: {
  viewer: CommentViewer;
  onSettings: (settings: CommentSettings) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(viewer.name ?? "");
  const [busy, setBusy] = useState(false);
  const save = async (settings: CommentSettings) => {
    setBusy(true);
    try {
      await onSettings(settings);
      setEditing(false);
    } catch {
      /* the rail shows the error */
    } finally {
      setBusy(false);
    }
  };
  return (
    <footer className="comments-settings">
      {viewer.nameChosen && (
        editing ? (
          <form
            className="comments-settings-name"
            onSubmit={(event) => {
              event.preventDefault();
              void save({ displayName: name });
            }}
          >
            <input
              className="ui-input"
              value={name}
              maxLength={40}
              aria-label="Имя под комментариями"
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" variant="quiet" busy={busy} disabled={!name.trim()}>
              Сохранить
            </Button>
          </form>
        ) : (
          <p>
            Под комментариями: <strong>{viewer.name}</strong>{" "}
            <button type="button" className="text-button" onClick={() => setEditing(true)}>
              Изменить
            </button>
          </p>
        )
      )}
      <p>
        Письма о комментариях {viewer.commentMail ? "приходят" : "отключены"}.{" "}
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => void save({ commentMail: !viewer.commentMail })}
        >
          {viewer.commentMail ? "Отключить" : "Включить"}
        </button>
      </p>
    </footer>
  );
}

function ReactionChips({
  groups,
  disabled,
  onToggle,
}: {
  groups: ReactionGroup[];
  disabled: boolean;
  onToggle: (emoji: Reaction) => Promise<void>;
}) {
  return (
    <span className="reaction-chips">
      {groups.map((group) => (
        <button
          key={group.emoji}
          type="button"
          className="reaction-chip"
          aria-pressed={group.mine}
          disabled={disabled}
          title={group.mine ? "Снять реакцию" : "Поставить такую же"}
          onClick={(event) => {
            event.stopPropagation();
            void onToggle(group.emoji).catch(() => {});
          }}
        >
          <span aria-hidden="true">{group.emoji}</span> {group.count}
        </button>
      ))}
    </span>
  );
}

function Composer({
  anchor,
  signedIn,
  onSignIn,
  onCancel,
  onSubmit,
  cardRef,
  style,
  placeholder = "Ваш комментарий",
  compact = false,
}: {
  anchor: CommentAnchor | null;
  signedIn: boolean;
  onSignIn?: () => void;
  onCancel: () => void;
  onSubmit: (body: string, displayName?: string) => Promise<void>;
  cardRef?: (element: HTMLElement | null) => void;
  style?: React.CSSProperties;
  placeholder?: string;
  compact?: boolean;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const naming = useContext(NameChoice);
  const [name, setName] = useState(naming.suggested);
  const field = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => field.current?.focus(), []);
  const length = [...body].length;
  const Tag = compact ? "div" : "article";
  if (!signedIn)
    return (
      <Tag ref={cardRef as any} style={style} className="comment-card comment-card--composer">
        {anchor && <blockquote className="comment-quote">{quote(anchor.exact)}</blockquote>}
        <p className="comment-signin">Войдите по почте, чтобы оставить комментарий.</p>
        <div className="comment-actions">
          {onSignIn && (
            <Button variant="primary" onClick={onSignIn}>
              <LogIn /> Войти по почте
            </Button>
          )}
          <Button variant="quiet" onClick={onCancel}>
            Отмена
          </Button>
        </div>
      </Tag>
    );
  return (
    <Tag ref={cardRef as any} style={style} className={`comment-card comment-card--composer${compact ? " comment-card--inline" : ""}`}>
      {!compact && (
        <blockquote className="comment-quote">
          {anchor ? quote(anchor.exact) : "Ко всей работе"}
        </blockquote>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!body.trim() || busy) return;
          setBusy(true);
          try {
            await onSubmit(body, naming.needed ? name : undefined);
            setBody("");
          } catch {
            /* the rail shows the error */
          } finally {
            setBusy(false);
          }
        }}
      >
        {naming.needed && (
          <div className="comment-name">
            <label>
              <span>Ваше имя под комментариями</span>
              <input
                className="ui-input"
                value={name}
                maxLength={40}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <small>
              Имя и текст комментария увидят все, у кого есть ссылка, и автор
              работы. Почту мы не показываем.
            </small>
          </div>
        )}
        <textarea
          ref={field}
          className="ui-input comment-input"
          value={body}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={compact ? 2 : 3}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel();
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              (event.currentTarget.form as HTMLFormElement).requestSubmit();
          }}
        />
        <div className="comment-actions">
          <span className="comment-length" data-over={length > COMMENT_MAX_CHARS || undefined}>
            {length > COMMENT_MAX_CHARS - 200 ? `${length} / ${COMMENT_MAX_CHARS}` : ""}
          </span>
          <Button variant="quiet" onClick={onCancel} disabled={busy}>
            Отмена
          </Button>
          <Button
            variant="primary"
            type="submit"
            busy={busy}
            disabled={
              !body.trim() ||
              length > COMMENT_MAX_CHARS ||
              (naming.needed && !name.trim())
            }
          >
            Отправить
          </Button>
        </div>
      </form>
    </Tag>
  );
}

function Byline({ comment }: { comment: CommentView }) {
  return (
    <header className="comment-byline">
      <strong>{comment.author ? comment.author.name : "Комментарий удалён"}</strong>
      {comment.author?.owner && <span className="comment-badge">автор работы</span>}
      {comment.held && (
        <span className="comment-badge comment-badge--held" title="Комментарий похож на попытку выманить данные. Его видят только автор и владелец работы, пока модератор Полки не решит.">
          на проверке
        </span>
      )}
      <time dateTime={comment.createdAt}>{dateTime(comment.createdAt)}</time>
    </header>
  );
}

function ThreadCard({
  thread,
  reactions,
  missing,
  active,
  onActivate,
  signedIn,
  readOnly,
  actions,
  run,
  onReport,
  onSignIn,
  cardRef,
  style,
}: {
  thread: CommentThread;
  reactions: ReactionGroup[];
  missing: string | null;
  active: boolean;
  onActivate: () => void;
  signedIn: boolean;
  readOnly: boolean;
  actions: DiscussionActions;
  run: (action: () => Promise<void>) => Promise<void>;
  onReport?: (commentId: string) => void;
  onSignIn?: () => void;
  cardRef: (element: HTMLElement | null) => void;
  style?: React.CSSProperties;
}) {
  const [replying, setReplying] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const commentActions = (comment: CommentView, root: boolean) => (
    <div className="comment-actions" onClick={(event) => event.stopPropagation()}>
      {confirm === comment.id ? (
        <>
          <span className="comment-confirm">Удалить комментарий?</span>
          <Button variant="quiet" onClick={() => setConfirm(null)}>
            Нет
          </Button>
          <Button
            variant="quiet"
            className="danger"
            onClick={() => void run(() => actions.remove(comment.id)).catch(() => {})}
          >
            Удалить
          </Button>
        </>
      ) : (
        <>
          {root && !readOnly && !thread.deleted && (
            <Button
              variant="quiet"
              onClick={() => (signedIn ? setReplying(true) : onSignIn?.())}
            >
              <CornerDownRight /> Ответить
            </Button>
          )}
          {root && thread.anchor && !readOnly && !thread.deleted && (
            <Button
              variant="quiet"
              aria-label="Реакция"
              aria-expanded={picking}
              onClick={() => (signedIn ? setPicking((value) => !value) : onSignIn?.())}
            >
              <SmilePlus />
            </Button>
          )}
          {root && comment.canResolve && (
            <Button
              variant="quiet"
              onClick={() =>
                void run(() => actions.resolve(comment.id, !comment.resolvedAt)).catch(() => {})
              }
            >
              {comment.resolvedAt ? (
                <>
                  <RotateCcw /> Вернуть
                </>
              ) : (
                <>
                  <Check /> Решено
                </>
              )}
            </Button>
          )}
          {comment.canDelete && (
            <Button variant="quiet" aria-label="Удалить" onClick={() => setConfirm(comment.id)}>
              <Trash2 />
            </Button>
          )}
          {onReport && !comment.deleted && !comment.author?.me && (
            <Button variant="quiet" aria-label="Пожаловаться на комментарий" onClick={() => onReport(comment.id)}>
              <Flag />
            </Button>
          )}
        </>
      )}
    </div>
  );
  return (
    <article
      ref={cardRef}
      style={style}
      className="comment-card"
      data-active={active || undefined}
      data-resolved={thread.resolvedAt ? true : undefined}
      onClick={onActivate}
    >
      {thread.anchor && (
        <blockquote className="comment-quote" data-missing={missing ? true : undefined}>
          {quote(thread.anchor.exact)}
          {missing && <span className="comment-missing">{missing}</span>}
        </blockquote>
      )}
      <Byline comment={thread} />
      {!thread.deleted && <p className="comment-body">{thread.body}</p>}
      {reactions.length > 0 && (
        <ReactionChips
          groups={reactions}
          disabled={!signedIn || readOnly}
          onToggle={(emoji) => run(() => actions.react(emoji, thread.anchor))}
        />
      )}
      {picking && thread.anchor && (
        <div className="reaction-picker" role="group" aria-label="Реакции" onClick={(event) => event.stopPropagation()}>
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="reaction-pick"
              onClick={() => {
                setPicking(false);
                void run(() => actions.react(emoji, thread.anchor)).catch(() => {});
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {commentActions(thread, true)}
      {thread.replies.length > 0 && (
        <ol className="comment-replies">
          {thread.replies.map((reply) => (
            <li key={reply.id} className="comment-reply">
              <Byline comment={reply} />
              <p className="comment-body">{reply.body}</p>
              {commentActions(reply, false)}
            </li>
          ))}
        </ol>
      )}
      {replying && (
        <div onClick={(event) => event.stopPropagation()}>
          <Composer
            compact
            anchor={null}
            signedIn={signedIn}
            onSignIn={onSignIn}
            placeholder="Ответ"
            onCancel={() => setReplying(false)}
            onSubmit={async (body, displayName) => {
              await run(() =>
                actions.create({
                  body,
                  parentId: thread.id,
                  ...(displayName ? { displayName } : {}),
                }),
              );
              setReplying(false);
            }}
          />
        </div>
      )}
    </article>
  );
}
