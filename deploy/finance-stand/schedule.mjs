// When the stand's work runs by itself (fin.mjs due, finance-schedule.timer).
// A pack says it in «trigger: timer:» — «daily 09:00», «mon 10:00» or
// «every» (each pass of the timer: the inbox, letters as they come). The key
// is the stand's own: the swarm starts only «schedule» packs, and those take
// their files from a folder, while these gather what the systems hold.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contour } from "./contour.mjs";

const PROCESSES = fileURLToPath(new URL("./processes/", import.meta.url));
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** The stand's packs with a timer, in the order a working day runs them. */
export async function timedPacks(dir = PROCESSES) {
  const { parseProfile } = await contour("dispatcher.mjs");
  const packs = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort()) {
    const p = parseProfile(await readFile(join(dir, f), "utf8"));
    // fin.match runs as «fin.mjs match»: the command gathers the pack's inputs.
    if (p.trigger?.timer)
      packs.push({ process: p.process, timer: String(p.trigger.timer), step: p.process.split(".")[1] });
  }
  // Letters first (a УПД that came closes its tail), then the match, then
  // what is still missing is asked for.
  const order = ["inbox", "match", "chase", "remind"];
  return packs.sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
}

/** The last slot of a timer at or before `at`; «every» has none. */
export function lastSlot(timer, at) {
  if (timer === "every") return null;
  const [day, hm] = timer.split(" ");
  if (!(day === "daily" || day in DAYS) || !/^\d{2}:\d{2}$/.test(hm ?? "")) throw new Error(`расписание «${timer}»`);
  const [h, m] = hm.split(":").map(Number);
  const slot = new Date(at);
  slot.setHours(h, m, 0, 0);
  if (day === "daily") {
    if (slot > at) slot.setDate(slot.getDate() - 1);
  } else {
    let back = (slot.getDay() - DAYS[day] + 7) % 7;
    if (back === 0 && slot > at) back = 7;
    slot.setDate(slot.getDate() - back);
  }
  return slot;
}

/** What is due at `at`, given when each pack last ran: [{...pack, slot}]. A
 * stand switched on late runs a missed slot once, not a week of them; the
 * caller records `slot` only when the run went through, so a failed one is
 * tried again on the next pass. */
export function due(packs, last, at) {
  return packs
    .map((p) => ({ ...p, slot: lastSlot(p.timer, at) }))
    .filter((p) => !p.slot || !last[p.process] || new Date(last[p.process]) < p.slot);
}
