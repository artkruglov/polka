export const REMIND_AFTER_MS: number;
export function decide(
  before: { failing: string[]; alertedAt: string | null },
  failing: string[],
  now?: number,
): "none" | "changed" | "reminder";
export function handler(): Promise<{ failing: string[]; alerted: boolean }>;
