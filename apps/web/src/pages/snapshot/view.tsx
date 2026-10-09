import React from "react";
import type { SnapshotItem } from "../../shared/api/client.ts";
import { dateTime } from "../../entities/artifact/format.ts";
import { Badge, Button, EmptyState } from "../../shared/ui/controls.tsx";

/** «2026-10-08T14:30» for <input type="datetime-local">, in local time. */
export function localInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const plural = new Intl.PluralRules("ru");
const works = (n: number) =>
  (({ one: "работа", few: "работы", many: "работ" }) as Record<string, string>)[plural.select(n)] ?? "работы";
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What the acceptance was then, and what is true of the work now. */
function marks(item: SnapshotItem) {
  let accepted: React.ReactNode = null;
  if (item.acceptedRevisionId === item.revision.id) accepted = <Badge tone="success">Эта версия принята</Badge>;
  else if (item.acceptedRevisionId)
    accepted = (
      <Badge tone="accent">
        {item.acceptedRevisionNumber ? `Принята версия ${item.acceptedRevisionNumber}` : "Принята другая версия"}
      </Badge>
    );
  const now: string[] = [];
  if (item.now.trashed) now.push("сейчас в корзине");
  if (item.now.latestRevisionNumber && item.now.latestRevisionNumber > item.revision.number)
    now.push(`сейчас версия ${item.now.latestRevisionNumber}`);
  return { accepted, now };
}

/**
 * The works of a shelf at a moment, read-only. Each opens at the version it
 * had then, on the same shelf (hrefFor).
 */
export function SnapshotList({
  at,
  items,
  nextCursor,
  busy = false,
  onMore,
  hrefFor,
}: {
  at: string;
  items: SnapshotItem[];
  nextCursor: string | null;
  busy?: boolean;
  onMore: () => void;
  hrefFor: (item: SnapshotItem) => string;
}) {
  if (!items.length)
    return (
      <EmptyState title="В этот момент полка была пуста">
        Работ ещё не было или все лежали в корзине. Выберите момент позже.
      </EmptyState>
    );
  return (
    <section className="snapshot-result" aria-label={`Полка на ${dateTime(at)}`}>
      <p className="snapshot-summary">
        {dateTime(at)}: {nextCursor ? "больше " : ""}
        {items.length} {works(items.length)} на полке.
      </p>
      <ul className="snapshot-list">
        {items.map((item) => {
          const { accepted, now } = marks(item);
          return (
            <li key={item.id} className="snapshot-item">
              <a className="snapshot-title" href={hrefFor(item)}>
                {item.title}
              </a>
              <span className="snapshot-meta">
                <span>
                  Версия {item.revision.number} от {dateTime(item.revision.createdAt)}
                </span>
                {accepted}
                {now.length > 0 && <span className="snapshot-now">{capitalize(now.join(", "))}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {nextCursor && (
        <Button busy={busy} onClick={onMore}>
          Показать ещё
        </Button>
      )}
    </section>
  );
}
