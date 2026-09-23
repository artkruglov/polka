import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommentAnchor,
  Reaction,
  SharedComments,
  WorkComments,
} from "../../../../../packages/contracts/comments.ts";
import { ApiError, client, type NewComment } from "../../shared/api/client.ts";

/** What the rail can do; each resolves once the server agreed. */
export type DiscussionActions = {
  create: (input: NewComment) => Promise<void>;
  react: (emoji: Reaction, anchor: CommentAnchor | null) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
  resolve: (commentId: string, resolved: boolean) => Promise<void>;
};

const REFRESH_MS = 30_000;

/** Reload every half minute while the tab is visible. */
function usePolling(reload: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload, enabled]);
}

/**
 * The threads of the link a recipient opened. `unavailable` when the link
 * has no discussion (an editorial page, or the link closed meanwhile).
 */
export function useSharedDiscussion(token: string, enabled = true) {
  const [data, setData] = useState<SharedComments | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reload = useCallback(() => {
    const current = ++generation.current;
    client.comments
      .shared(token)
      .then((next) => {
        if (current !== generation.current) return;
        setData(next);
        setError("");
      })
      .catch((e) => {
        if (current !== generation.current) return;
        if (e instanceof ApiError && e.status === 404) setUnavailable(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
  }, [token]);
  useEffect(() => {
    if (!enabled) return;
    setData(null);
    setUnavailable(false);
    reload();
  }, [reload, enabled]);
  usePolling(reload, enabled && !unavailable);
  const after = useCallback(
    async (action: Promise<unknown>) => {
      await action;
      reload();
    },
    [reload],
  );
  const actions: DiscussionActions = {
    create: (input) => after(client.comments.create(token, input)),
    react: (emoji, anchor) => after(client.comments.react(token, emoji, anchor)),
    remove: (id) => after(client.comments.remove(token, id)),
    resolve: (id, resolved) =>
      after(client.comments.resolve(token, id, resolved)),
  };
  return { data, unavailable, error, reload, actions };
}

/** Every link's threads of the owner's work. */
export function useWorkDiscussion(artifactId: string, enabled = true) {
  const [data, setData] = useState<WorkComments | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reload = useCallback(() => {
    const current = ++generation.current;
    client.comments
      .work(artifactId)
      .then((next) => {
        if (current !== generation.current) return;
        setData(next);
        setError("");
      })
      .catch((e) => {
        if (current === generation.current)
          setError(e instanceof Error ? e.message : String(e));
      });
  }, [artifactId]);
  useEffect(() => {
    if (!enabled) return;
    setData(null);
    reload();
  }, [reload, enabled]);
  usePolling(reload, enabled);
  const after = useCallback(
    async (action: Promise<unknown>) => {
      await action;
      reload();
    },
    [reload],
  );
  const actionsFor = (shareId: string): DiscussionActions => ({
    create: (input) =>
      after(client.comments.ownerCreate(artifactId, shareId, input)),
    react: (emoji, anchor) =>
      after(client.comments.ownerReact(artifactId, shareId, emoji, anchor)),
    remove: (id) => after(client.comments.ownerRemove(id)),
    resolve: (id, resolved) =>
      after(client.comments.ownerResolve(id, resolved)),
  });
  const markSeen = useCallback(() => {
    void client.comments
      .seen(artifactId)
      .then(() =>
        setData((current) => (current ? { ...current, unread: 0 } : current)),
      )
      .catch(() => {});
  }, [artifactId]);
  return { data, error, reload, actionsFor, markSeen };
}
