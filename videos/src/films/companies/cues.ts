import { at, type Grid } from "../../kit/time";

// «Для компаний» v3: silent landing loop at 132 BPM (a bar is 1.82 s), ≈ 34.5 s.
// Agents in every department make work that is lost in chats; then one shot
// per feature, about a bar each, while a rail on the right checks off
// everything Полка does for a company.
export const GRID: Grid = { bpm: 132, firstBeat: 0, pickupBeats: 0, beatsPerBar: 4 };
export const b = (bar: number, beat = 1, fraction = 0) => at(GRID, bar, beat, fraction);

export const FEATURE_BAR = 8; // the first feature shot
export const FEATURES = 9;
export const feature = (i: number) => b(FEATURE_BAR + i);

export const CUES = {
  markDraw: [b(1, 1), b(1, 4, 0.5)] as const,
  line1: [b(2, 1), b(2, 2), b(2, 3), b(2, 4)] as const, // «Агенты работают / в каждом отделе.»
  line1Out: b(3, 3),
  // 3–5. Six department chats stream their works in, then close.
  windowsIn: Array.from({ length: 6 }, (_, i) => b(3, 4, i * 0.5)),
  closing: Array.from({ length: 6 }, (_, i) => b(5, 2, i * 0.25)),
  windowsOut: b(6, 1),
  line2: [b(6, 1), b(6, 2), b(6, 3), b(6, 4)] as const, // «Работа теряется в чатах.»
  line2Out: b(6, 4, 0.75),
  line3: [b(7, 1), b(7, 2), b(7, 3), b(7, 4)] as const, // «Соберите всё на Полке.»
  line3Out: b(7, 4, 0.75),
  // 8–16. One shot per feature (feature(i) .. feature(i + 1)).
  featuresIn: b(FEATURE_BAR),
  featuresOut: b(FEATURE_BAR + FEATURES),
  // 17–19. «Полка для компаний.», the mark, back to an empty frame.
  line5: [b(17, 1), b(17, 2), b(17, 3)] as const,
  line5Out: b(18, 3),
  markEnd: [b(17, 1), b(19, 2)] as const,
} as const;

export const DURATION = b(19, 3);
