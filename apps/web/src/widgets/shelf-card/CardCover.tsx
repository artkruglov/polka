import React, { useEffect, useRef, useState } from "react";
import {
  AppWindow,
  FileText,
  Globe,
  Hash,
  Image as ImageIcon,
  LayoutDashboard,
  Link as LinkIcon,
  NotebookText,
  StickyNote,
} from "lucide-react";
import type { Artifact } from "../../../../../packages/contracts/index.ts";
import {
  coverImageUrl,
  type CoverGenre,
  type RevisionCover,
} from "../../../../../packages/contracts/cover.ts";
import { client } from "../../shared/api/client.ts";
import { providerById } from "../../entities/link/index.tsx";
import { ServiceMark } from "../../shared/ui/ServiceMark.tsx";
import { GENRE_LABEL, cardKind, coverAccent } from "./cover-model.ts";

/*
 * A card's cover (docs/specs/SHELF_COVERS.md): never the page itself. A
 * picture of the first screen for a visual work, a typographic cover with the
 * document's own heading and lead for a text one. The decision comes with the
 * shelf list; a card of a version not decided yet asks once, when it comes
 * near the viewport.
 */

const GENRE_ICON: Record<CoverGenre, React.ComponentType<{ className?: string }>> = {
  report: NotebookText,
  document: FileText,
  note: StickyNote,
  markdown: Hash,
  dashboard: LayoutDashboard,
  app: AppWindow,
  page: Globe,
  image: ImageIcon,
};

// One request per version for the whole session, whichever view asks.
const asked = new Map<string, Promise<RevisionCover | null>>();
const askCover = (revisionId: string, fresh = false) => {
  if (fresh) asked.delete(revisionId);
  let pending = asked.get(revisionId);
  if (!pending) {
    pending = client.cover(revisionId).catch(() => null);
    asked.set(revisionId, pending);
  }
  return pending;
};

/** The stored cover, or the one the server decides now; follows a picture being drawn. */
export function useCover(a: Artifact, near: boolean) {
  const initial = a.revision.link ? null : a.revision.cover;
  const [cover, setCover] = useState<RevisionCover | null | undefined>(initial ?? undefined);
  useEffect(() => setCover(initial ?? undefined), [a.revision.id]);
  const polls = useRef(0);
  useEffect(() => {
    if (!near || a.revision.link) return;
    if (cover && cover.image !== "pending") return;
    let live = true;
    // A picture being drawn: ask again a few times, then keep the text cover.
    const delay = cover ? 3_000 : 0;
    if (cover && polls.current >= 10) return;
    const timer = setTimeout(() => {
      polls.current++;
      askCover(a.revision.id, !!cover).then((next) => {
        if (live) setCover(next);
      });
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [near, a.revision.id, cover?.image]);
  return cover;
}

export function CardCover({
  a,
  near,
  cover,
  thumb = false,
  series,
}: {
  a: Artifact;
  near: boolean;
  /** From useCover: undefined while not known yet. */
  cover: RevisionCover | null | undefined;
  /** The list view's small thumbnail: a picture or a tinted tile with the kind's icon. */
  thumb?: boolean;
  series?: { name: string; count: number } | null;
}) {
  const [broken, setBroken] = useState(false);
  const r = a.revision;
  if (r.link) {
    if (thumb) return <Tile a={a} icon={LinkIcon} />;
    // The title is under the cover already: the cover names where the link leads.
    const provider = providerById(r.link.service);
    return (
      <div className="card-cover card-cover--link" aria-hidden="true">
        <ServiceMark provider={provider} size="lg" />
        <strong>{provider?.name ?? "Ссылка"}</strong>
        <span>
          <LinkIcon /> {r.link.host}
        </span>
      </div>
    );
  }
  if (!near || cover === undefined) return <div className="placeholder" aria-hidden="true" />;
  if (cover && cover.image === "ready" && !broken)
    return (
      <div className="card-cover card-cover--picture">
        <img
          src={coverImageUrl(r.id, cover)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
        {!thumb && series && <SeriesBadge series={series} />}
      </div>
    );
  const Icon = cover ? GENRE_ICON[cover.genre] ?? FileText : FileText;
  if (thumb) return <Tile a={a} icon={Icon} cover={cover} />;
  const { color } = coverAccent(a, cover);
  const heading = cover?.heading || a.title;
  const visual = cover?.kind === "visual";
  return (
    <div
      className={`card-cover card-cover--${visual ? "visual" : "text"}`}
      style={{ "--cover-accent": color } as React.CSSProperties}
      aria-hidden="true"
    >
      <div className="card-cover-top">
        <span className="card-cover-kind">
          <Icon />
          {cover ? GENRE_LABEL[cover.genre] : cardKind(a)}
        </span>
        {series && <SeriesBadge series={series} />}
      </div>
      <strong className="card-cover-heading">{heading}</strong>
      {cover?.lead && <p className="card-cover-lead">{cover.lead}</p>}
      {visual && cover?.image === "pending" && <span className="card-cover-note">Готовим превью…</span>}
    </div>
  );
}

function SeriesBadge({ series }: { series: { name: string; count: number } }) {
  return (
    <span className="card-cover-series" title={`Серия «${series.name}»: ${series.count} на полке`}>
      {series.name}
      <span aria-hidden="true"> · {series.count}</span>
    </span>
  );
}

function Tile({
  a,
  icon: Icon,
  cover,
}: {
  a: Artifact;
  icon: React.ComponentType<{ className?: string }>;
  cover?: RevisionCover | null;
}) {
  const { color } = coverAccent(a, cover);
  return (
    <div className="card-cover card-cover--tile" style={{ "--cover-accent": color } as React.CSSProperties} aria-hidden="true">
      <Icon />
    </div>
  );
}
