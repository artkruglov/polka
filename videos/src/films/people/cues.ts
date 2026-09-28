import { at, type Grid } from "../../kit/time";

// «Для людей»: silent landing loop, 18 bars at 132 BPM (a bar is 1.82 s, the film ≈ 32.7 s).
// The traveler is one work, «Бюджет поездки»: the agent's answer → a card on
// «Моя полка» → a link → a post → a friend's phone.
export const GRID: Grid = { bpm: 132, firstBeat: 0, pickupBeats: 0, beatsPerBar: 4 };
export const b = (bar: number, beat = 1, fraction = 0) => at(GRID, bar, beat, fraction);
export const DURATION = b(19);

export const CUES = {
  // 1. The mark draws itself.
  markDraw: [b(1, 1), b(1, 4, 0.5)] as const,
  // 2–3. «Сделали с агентом.»
  line1: [b(2, 1), b(2, 2), b(2, 3)] as const,
  line1Out: b(3, 4, 0.5),
  // 4–6. The agent's chat: its answer, «Сохрани это на Полку», saved.
  chatIn: b(4, 1),
  answer: b(4, 1, 0.5),
  typeStart: b(5, 3),
  typeEnd: b(6, 1, 0.5),
  send: b(6, 2),
  saved: b(6, 3, 0.5),
  // 7. The work flies onto «Моя полка».
  shelfIn: b(7, 1),
  fly: b(7, 1, 0.5),
  chatOut: b(7, 2),
  landed: b(7, 3),
  shelfOut: b(8, 1),
  // 8. «Одна ссылка.»
  line2: [b(8, 1, 0.25), b(8, 2, 0.25)] as const,
  line2Out: b(8, 4, 0.5),
  // 9–11. «Поделиться»: «По ссылке», enable, copy.
  shareIn: b(9, 1),
  pickLink: b(9, 3),
  enable: b(10, 2),
  linkReady: b(10, 3, 0.5),
  copy: b(11, 2),
  shareOut: b(12, 1),
  // 12–13. The link travels into a post.
  postIn: b(12, 1),
  linkFly: b(11, 4, 0.5),
  linkLanded: b(12, 3),
  postOut: b(14, 1),
  // 14–15. A friend opens it on the phone.
  phoneIn: b(14, 1),
  pageOpen: b(14, 1, 0.5),
  phoneOut: b(16, 1),
  // 16. «Открывается без регистрации.»
  line3: [b(16, 1, 0.25), b(16, 2, 0.25), b(16, 3, 0.25)] as const,
  line3Out: b(16, 4, 0.5),
  // 17–18. «Покажите другим.», the mark, then back to an empty frame.
  line4: [b(17, 1), b(17, 2)] as const,
  line4Out: b(18, 2, 0.5),
  markEnd: [b(17, 1), b(18, 4)] as const,
} as const;
