import React, { useEffect, useState } from "react";
import type {
  CommentAnchor,
  Reaction,
  ShareDiscussion,
} from "../../../../../packages/contracts/comments.ts";
import { signInFromShare } from "../../shared/lib/share-return.ts";
import { useOverlayBridge } from "./bridge.ts";
import {
  CommentsRail,
  anchorsOf,
  type PendingComment,
} from "./CommentsRail.tsx";
import { SelectionButton } from "./SelectionButton.tsx";
import { useSharedDiscussion, useWorkDiscussion } from "./useDiscussion.ts";

/** Wide screens get the rail beside the document; phones a bottom sheet. */
function useWide() {
  const query = "(min-width: 761px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setWide(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return wide;
}

/** What a page places: the toggle's count, the panel, the frame hook, the floating button. */
export type CommentsPlacement = {
  available: boolean;
  count: number;
  open: boolean;
  onToggle: () => void;
  panel: React.ReactNode;
  overlay: { onFrame: (frame: HTMLIFrameElement | null) => void };
  floating: React.ReactNode;
};

function useOpenState(wide: boolean, count: number | null) {
  const [open, setOpen] = useState<boolean | null>(null);
  // Decided once, when the discussion first arrives: open on a wide screen
  // when there is something to read; the phone's sheet starts closed.
  useEffect(() => {
    if (open === null && count !== null) setOpen(wide && count > 0);
  }, [open, count, wide]);
  return [open ?? false, setOpen] as const;
}

/**
 * A recipient's comments on the link they opened. Signing in to write leaves
 * for the sign-in page and comes back to the same link (share-return.ts).
 */
export function useSharedComments({
  token,
  enabled,
  onReport,
}: {
  token: string;
  enabled: boolean;
  onReport?: (commentId: string) => void;
}): CommentsPlacement {
  const bridge = useOverlayBridge();
  const wide = useWide();
  const { data, unavailable, error, actions } = useSharedDiscussion(
    token,
    enabled,
  );
  const count = data ? data.threads.filter((t) => !t.deleted && !t.resolvedAt).length : 0;
  const [open, setOpen] = useOpenState(wide, data ? count : null);
  const [pending, setPending] = useState<PendingComment>(null);
  const signedIn = !!data?.viewer.signedIn;
  useEffect(() => {
    if (data) bridge.setAnchors(anchorsOf(data));
  });
  // A click on a highlight opens the discussion (the phone's sheet too).
  useEffect(() => {
    if (bridge.state.focus) setOpen(true);
  }, [bridge.state.focus, setOpen]);
  const signIn = () => location.assign(signInFromShare(token));
  const comment = (anchor: CommentAnchor) => {
    setPending({ anchor });
    setOpen(true);
    bridge.clearSelection();
  };
  const react = (emoji: Reaction, anchor: CommentAnchor) => {
    if (!signedIn) return comment(anchor);
    bridge.clearSelection();
    void actions.react(emoji, anchor).catch(() => {});
  };
  const panel = data ? (
    <CommentsRail
      discussion={data}
      signedIn={signedIn}
      actions={actions}
      bridge={bridge}
      pending={pending}
      onPendingChange={setPending}
      onSignIn={signIn}
      onReport={onReport}
      layout={wide ? "rail" : "sheet"}
      onClose={() => setOpen(false)}
    />
  ) : (
    <p className="comments-empty" role="status">
      {error || "Загружаем комментарии…"}
    </p>
  );
  return {
    available: enabled && !unavailable,
    count,
    open,
    onToggle: () => setOpen(!open),
    panel,
    overlay: bridge.overlay,
    floating:
      enabled && !unavailable && bridge.state.selection ? (
        <SelectionButton
          selection={bridge.state.selection}
          onComment={comment}
          onReact={react}
        />
      ) : null,
  };
}

const shareLabel = (share: ShareDiscussion, index: number) =>
  `${index === 0 ? "Текущая ссылка" : "Ссылка"} · версия ${share.revisionNumber}${
    share.state === "active" ? "" : share.state === "revoked" ? " · закрыта" : " · истекла"
  }`;

/**
 * The owner's view on the work page: the threads of every link, one link at
 * a time, with the unread counter. Opening the panel marks them read.
 */
export function useWorkComments({
  artifactId,
  enabled,
}: {
  artifactId: string;
  enabled: boolean;
}): CommentsPlacement & { unread: number } {
  const bridge = useOverlayBridge();
  const wide = useWide();
  const { data, actionsFor, markSeen } = useWorkDiscussion(artifactId, enabled);
  const [shareId, setShareId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingComment>(null);
  const shares = data?.shares ?? [];
  const share = shares.find((s) => s.shareId === shareId) ?? shares[0] ?? null;
  const count = shares.reduce(
    (total, s) => total + s.threads.filter((t) => !t.deleted && !t.resolvedAt).length,
    0,
  );
  const [open, setOpen] = useOpenState(wide, data ? data.unread : null);
  // Opening marks the comments read; the panel keeps saying how many were new.
  const [fresh, setFresh] = useState(0);
  useEffect(() => {
    if (open && data?.unread) {
      setFresh(data.unread);
      markSeen();
    }
  }, [open, data?.unread, markSeen]);
  const actions = share ? actionsFor(share.shareId) : null;
  useEffect(() => {
    bridge.setAnchors(share ? anchorsOf(share) : []);
  });
  useEffect(() => {
    if (bridge.state.focus) setOpen(true);
  }, [bridge.state.focus, setOpen]);
  const writable = share?.state === "active";
  const comment = (anchor: CommentAnchor) => {
    setPending({ anchor });
    setOpen(true);
    bridge.clearSelection();
  };
  const panel =
    share && actions ? (
      <CommentsRail
        key={share.shareId}
        discussion={share}
        signedIn
        actions={actions}
        bridge={bridge}
        pending={pending}
        onPendingChange={setPending}
        layout={wide ? "rail" : "sheet"}
        readOnly={!writable}
        onClose={() => setOpen(false)}
        header={
          <>
          {fresh > 0 && (
            <p className="comments-fresh" role="status">
              Новых с прошлого раза: {fresh}
            </p>
          )}
          {shares.length > 1 ? (
            <label className="comments-share">
              <span>Обсуждение ссылки</span>
              <select
                className="ui-input"
                value={share.shareId}
                onChange={(event) => setShareId(event.target.value)}
              >
                {shares.map((s, index) => (
                  <option key={s.shareId} value={s.shareId}>
                    {shareLabel(s, index)} · {s.threads.length}
                  </option>
                ))}
              </select>
            </label>
          ) : share.state !== "active" ? (
            <p className="comments-share-note">
              Ссылка {share.state === "revoked" ? "закрыта" : "истекла"}: получатели обсуждение
              больше не видят.
            </p>
          ) : null}
          </>
        }
      />
    ) : (
      <p className="comments-empty" role="status">
        {data
          ? "Комментарии появятся, когда вы отправите ссылку: получатели выделяют фрагмент и пишут замечание."
          : "Загружаем комментарии…"}
      </p>
    );
  return {
    available: enabled,
    count,
    unread: data?.unread ?? 0,
    open,
    onToggle: () => setOpen(!open),
    panel,
    overlay: bridge.overlay,
    floating:
      enabled && writable && bridge.state.selection ? (
        <SelectionButton
          selection={bridge.state.selection}
          onComment={comment}
          onReact={(emoji, anchor) => {
            bridge.clearSelection();
            void actions?.react(emoji, anchor).catch(() => {});
          }}
        />
      ) : null,
  };
}

