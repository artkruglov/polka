import type { Artifact } from "../../../../../packages/contracts/index.ts";
import type { CoverGenre, RevisionCover } from "../../../../../packages/contracts/cover.ts";
import { hueOf, kindOf } from "../../entities/artifact/format.ts";

/*
 * What a shelf card says about its cover (docs/specs/SHELF_COVERS.md). Pure
 * functions: Node tests import them without the DOM.
 */

export const GENRE_LABEL: Record<CoverGenre, string> = {
  report: "Отчёт",
  document: "Документ",
  note: "Заметка",
  markdown: "Markdown",
  dashboard: "Дашборд",
  app: "Приложение",
  page: "Страница",
  image: "Изображение",
};

/** The kind named on the card: the cover's genre once decided, else the file kind. */
export const cardKind = (
  a: Pick<Artifact, "revision">,
  cover: Pick<RevisionCover, "genre"> | null | undefined = a.revision.cover,
) => (cover && !a.revision.link ? GENRE_LABEL[cover.genre] ?? kindOf(a.revision) : kindOf(a.revision));

const SEPARATOR = /\s+[·|—–:]\s+|:\s+/;

/**
 * The series a title belongs to: what comes before its first separator
 * («Y360 Radar · неделя W36» → «Y360 Radar»). Null when the title has no
 * such prefix or the prefix is too short or too long to name a series.
 */
export function seriesOf(title: string): string | null {
  const match = SEPARATOR.exec(title);
  if (!match || match.index === 0) return null;
  const prefix = title.slice(0, match.index).trim();
  const rest = title.slice(match.index + match[0].length).trim();
  if (prefix.length < 2 || prefix.length > 40 || !rest) return null;
  return prefix;
}

/** Series that at least two loaded works share: prefix (case-insensitive) → count. */
export function seriesCounts(items: Array<Pick<Artifact, "title">>) {
  const counts = new Map<string, number>();
  for (const { title } of items) {
    const series = seriesOf(title);
    if (series) counts.set(series.toLocaleLowerCase("ru"), (counts.get(series.toLocaleLowerCase("ru")) ?? 0) + 1);
  }
  for (const [key, count] of counts) if (count < 2) counts.delete(key);
  return counts;
}

export function seriesBadge(title: string, counts: Map<string, number>) {
  const series = seriesOf(title);
  const count = series ? counts.get(series.toLocaleLowerCase("ru")) : undefined;
  return series && count ? { name: series, count } : null;
}

/** The accent of a cover: the page's own colour, else a stable hue (shared by a series). */
export function coverAccent(
  a: Pick<Artifact, "id" | "title">,
  cover: Pick<RevisionCover, "accent"> | null | undefined,
): { color: string; hue: number | null } {
  if (cover?.accent && /^#[0-9a-f]{6}$/i.test(cover.accent)) return { color: cover.accent, hue: null };
  const hue = hueOf(seriesOf(a.title)?.toLocaleLowerCase("ru") ?? a.id);
  return { color: `hsl(${hue} 58% 42%)`, hue };
}

const normalize = (value: string) =>
  value
    .toLocaleLowerCase("ru")
    .replace(/[«»"'“”.,:;!?·|—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Whether the cover's heading says what the title says (the card then does not repeat it large). */
export function sameText(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  return normalize(a) === normalize(b);
}
