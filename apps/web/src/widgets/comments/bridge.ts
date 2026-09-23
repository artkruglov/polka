import { useCallback, useEffect, useRef, useState } from "react";
import {
  anchorSchema,
  type CommentAnchor,
} from "../../../../../packages/contracts/comments.ts";

// The shell's side of the comment overlay protocol (apps/server/
// comment-overlay.ts). Messages are taken only from the one frame this
// bridge is attached to (event.source), and every field is checked: in the
// interactive view the page's own scripts share the overlay's window and can
// post anything. Nothing from the frame is ever rendered as HTML.
//
// What goes to the frame is the protocol only: quotes of the document
// ({id, exact, prefix, suffix}) and which one is active. No comment text,
// names or tokens. The frame's origin is opaque, so "*" is the only target.

export type FrameRect = { top: number; left: number; bottom: number; right: number };

export type OverlaySelection = {
  /** null when the fragment is too long to quote. */
  anchor: CommentAnchor | null;
  /** In the page's viewport, the frame's offset added. */
  rect: FrameRect;
};

export type OverlayState = {
  ready: boolean;
  /** Vertical position of each resolved anchor in the document. */
  positions: Record<string, number>;
  scrollY: number;
  viewport: number;
  /** Anchors the document does not contain (or not unambiguously). */
  missing: Set<string>;
  selection: OverlaySelection | null;
  /** The anchor the reader clicked in the document. */
  focus: { id: string; at: number } | null;
};

export type BridgeAnchor = {
  id: string;
  exact: string;
  prefix: string;
  suffix: string;
};

const INITIAL: OverlayState = {
  ready: false,
  positions: {},
  scrollY: 0,
  viewport: 0,
  missing: new Set(),
  selection: null,
  focus: null,
};

const finite = (value: unknown, max = 1e7) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max
    ? value
    : null;

function rectOf(value: unknown): FrameRect | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const top = finite(r.top),
    left = finite(r.left),
    bottom = finite(r.bottom),
    right = finite(r.right);
  return top === null || left === null || bottom === null || right === null
    ? null
    : { top, left, bottom, right };
}

export function useOverlayBridge() {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const anchors = useRef<BridgeAnchor[]>([]);
  const active = useRef<string | null>(null);
  const [state, setState] = useState<OverlayState>(INITIAL);

  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(message, "*");
  }, []);

  const onFrame = useCallback((element: HTMLIFrameElement | null) => {
    if (frame.current === element) return;
    frame.current = element;
    setState(INITIAL);
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string")
        return;
      switch (data.type) {
        case "polka:ready":
          setState((current) => ({ ...current, ready: true }));
          // A reloaded frame gets the current anchors again.
          post({ type: "polka:anchors", anchors: anchors.current });
          if (active.current) post({ type: "polka:active", id: active.current });
          return;
        case "polka:positions": {
          const positions: Record<string, number> = {};
          const raw = data.positions;
          if (raw && typeof raw === "object")
            for (const [id, y] of Object.entries(raw).slice(0, 1000)) {
              const value = finite(y);
              if (value !== null && id.length <= 100) positions[id] = value;
            }
          setState((current) => ({
            ...current,
            ready: true,
            positions,
            scrollY: finite(data.scrollY) ?? 0,
            viewport: finite(data.viewport) ?? 0,
          }));
          return;
        }
        case "polka:resolved": {
          const missing = new Set<string>();
          if (Array.isArray(data.missing))
            for (const id of data.missing.slice(0, 1000))
              if (typeof id === "string" && id.length <= 100) missing.add(id);
          setState((current) => ({ ...current, missing }));
          return;
        }
        case "polka:selection": {
          const rect = rectOf(data.rect);
          const frameRect = frame.current?.getBoundingClientRect();
          if (!rect || !frameRect) return;
          const parsed =
            data.tooLong === true ? null : anchorSchema.safeParse(data.anchor);
          if (parsed && !parsed.success) return;
          setState((current) => ({
            ...current,
            selection: {
              anchor: parsed ? parsed.data : null,
              rect: {
                top: rect.top + frameRect.top,
                bottom: rect.bottom + frameRect.top,
                left: rect.left + frameRect.left,
                right: rect.right + frameRect.left,
              },
            },
          }));
          return;
        }
        case "polka:selectionCleared":
          setState((current) =>
            current.selection ? { ...current, selection: null } : current,
          );
          return;
        case "polka:focus":
          if (typeof data.id === "string" && data.id.length <= 100)
            setState((current) => ({
              ...current,
              focus: { id: data.id as string, at: Date.now() },
            }));
          return;
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [post]);

  const setAnchors = useCallback(
    (next: BridgeAnchor[]) => {
      const same =
        next.length === anchors.current.length &&
        next.every(
          (anchor, index) =>
            anchor.id === anchors.current[index]!.id &&
            anchor.exact === anchors.current[index]!.exact,
        );
      anchors.current = next;
      if (!same) post({ type: "polka:anchors", anchors: next });
    },
    [post],
  );
  const setActive = useCallback(
    (id: string | null) => {
      if (active.current === id) return;
      active.current = id;
      post({ type: "polka:active", id });
    },
    [post],
  );
  const scrollTo = useCallback(
    (id: string) => post({ type: "polka:scrollTo", id }),
    [post],
  );
  const clearSelection = useCallback(() => {
    post({ type: "polka:clearSelection" });
    setState((current) => ({ ...current, selection: null }));
  }, [post]);
  /** The frame's top edge, for aligning cards with their fragments. */
  const frameTop = useCallback(
    () => frame.current?.getBoundingClientRect().top ?? null,
    [],
  );

  return {
    overlay: { onFrame },
    state,
    setAnchors,
    setActive,
    scrollTo,
    clearSelection,
    frameTop,
  };
}

export type OverlayBridge = ReturnType<typeof useOverlayBridge>;
