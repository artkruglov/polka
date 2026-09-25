import React, { useEffect, useRef, useState } from "react";
import "./styles.css";
import {
  ArrowUpRight,
  Ellipsis,
  ExternalLink,
  Folder as FolderIcon,
  LockKeyhole,
  Share2,
  Trash2,
  Users,
} from "lucide-react";
import type { Artifact } from "../../../../../packages/contracts/index.ts";
import { ActionMenu, type MenuAction } from "../../shared/ui/ActionMenu.tsx";
import { accessLabel, date, isLinked } from "../../entities/artifact/format.ts";
import { CardCover, useCover } from "./CardCover.tsx";
import { cardKind, sameText, seriesBadge } from "./cover-model.ts";

export type CardAction = "share" | "metadata" | "trash";

/** True once the element comes near the viewport; covers below the fold load nothing until then. */
function useNearViewport<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (near || !node) return;
    if (typeof IntersectionObserver !== "function") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near] as const;
}

/**
 * One work on the shelf (docs/specs/SHELF_COVERS.md): the cover, the title
 * (two lines at most), one meta line and «…». The whole card opens the work;
 * the title is the one link, stretched over the card.
 */
export function ShelfCard({
  a,
  view,
  series,
  open,
}: {
  a: Artifact;
  view: "grid" | "list";
  /** Series shared by at least two loaded works (seriesCounts). */
  series: Map<string, number>;
  open: (id: string, panel?: CardAction) => void;
}) {
  const [ref, near] = useNearViewport<HTMLElement>();
  const href = `/works/${a.id}`;
  const go = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    open(a.id);
  };
  const r = a.revision;
  const cover = useCover(a, near);
  const badge = seriesBadge(a.title, series);
  const echoed = cover?.kind === "text" && sameText(cover.heading, a.title);
  const items: MenuAction[] = [
    { id: "open", label: "Открыть", icon: <ArrowUpRight />, onSelect: () => open(a.id) },
    ...(r.link
      ? [
          {
            id: "original",
            label: "Открыть оригинал",
            icon: <ExternalLink />,
            // A link work opens its original in a new tab (docs/specs/SAVED_LINKS.md).
            onSelect: () => void window.open(`/api/revisions/${r.id}/open`, "_blank", "noopener,noreferrer"),
          },
        ]
      : []),
    { id: "share", label: "Поделиться", icon: <Share2 />, onSelect: () => open(a.id, "share") },
    { id: "metadata", label: "Название и папка", icon: <FolderIcon />, onSelect: () => open(a.id, "metadata") },
    { id: "trash", label: "В корзину", icon: <Trash2 />, tone: "danger", onSelect: () => open(a.id, "trash") },
  ];
  const linked = isLinked(a);
  return (
    <article ref={ref} className={`shelf-card${echoed ? " shelf-card--echo" : ""}`}>
      <div className="shelf-cover">
        <CardCover a={a} near={near} cover={cover} thumb={view === "list"} series={badge} />
      </div>
      <div className="shelf-card-body">
        <h3>
          <a className="shelf-card-link" href={href} onClick={go}>
            {a.title}
          </a>
        </h3>
        <p className="shelf-card-meta">
          <span className="shelf-card-access" title={accessLabel(a)}>
            {linked ? <Users aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
            <span className="sr-only">{accessLabel(a)}. </span>
          </span>
          <span>
            {cardKind(a, cover)} · v{r.number} · {date(a.updatedAt)}
          </span>
        </p>
      </div>
      <div className="shelf-card-actions">
        <ActionMenu label={`Действия: ${a.title}`} icon={<Ellipsis />} items={items} />
      </div>
    </article>
  );
}
