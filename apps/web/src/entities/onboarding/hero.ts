/**
 * Who sees the shelf's «Подключите агента» block (features/agent-hero):
 * young shelves and shelves with few works (owner's decision of 15.10.2026,
 * docs/specs/ONBOARDING_V2.md). Everyone else gets the one slim line, with
 * «Подключить агента» to open the steps on demand.
 */
export const HERO_MAX_SHELF_AGE_DAYS = 30;
/** Fewer works than this: the block is offered whatever the shelf's age. */
export const HERO_MAX_WORKS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * true: offer the block; false: one line; null: not known yet (an old shelf
 * whose works are not counted yet). An account without createdAt (made
 * before it was recorded) is old.
 */
export function heroOffered({
  createdAt,
  works,
  now = Date.now(),
}: {
  createdAt: string | null | undefined;
  /** Works on the whole shelf (no search or filter); null while unknown. */
  works: number | null;
  now?: number;
}): boolean | null {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isFinite(created) && now - created < HERO_MAX_SHELF_AGE_DAYS * DAY_MS) return true;
  if (works === null) return null;
  return works < HERO_MAX_WORKS;
}
