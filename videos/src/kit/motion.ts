import { Easing } from "remotion";
import { clamp01 } from "./time";

// Motion rules borrowed from HeyGen's HyperFrames (Apache-2.0):
// .claude/skills/motion-doctrine, cut-the-curve, registry/components/ui-focus-zoom,
// streaming-text, typed-prompt. Smooth beats bouncy; one direction (left);
// cut mid-motion instead of crossfading.

/** power3/expo-like out: the default for entrances and camera moves. */
export const out = Easing.bezier(0.16, 1, 0.3, 1);
const p4in = Easing.bezier(0.5, 0, 0.75, 0);
const p4out = Easing.bezier(0.25, 1, 0.5, 1);

/**
 * Cut-the-curve (cut-the-curve/SKILL.md §3): a scene enters travelling left from
 * +230 px (0.3 s, power4.out) and leaves on the same axis to −230 px (0.34 s,
 * power4.in), blurred while moving. Returns null when the scene is off.
 */
export function cut(t: number, enter: number, exit: number, travel = 230) {
  if (t < enter || t >= exit + 0.34) return null;
  if (t < enter + 0.3) {
    const u = p4out(clamp01((t - enter) / 0.3));
    return { translate: `${(1 - u) * travel}px 0`, opacity: clamp01(u / 0.3), filter: u < 1 ? `blur(${(1 - u) * 18}px)` : undefined };
  }
  if (t >= exit) {
    const u = p4in(clamp01((t - exit) / 0.34));
    return { translate: `${-u * travel}px 0`, opacity: 1 - clamp01((u - 0.7) / 0.3), filter: u > 0 ? `blur(${u * 18}px)` : undefined };
  }
  return { translate: "0 0", opacity: 1, filter: undefined as string | undefined };
}

/** A camera key: at `t` the view is centred on (x, y) of the 1920×1080 frame at `scale`. */
export type Shot = readonly [t: number, x: number, y: number, scale: number];

/**
 * Focus zoom (ui-focus-zoom): the camera eases between keys over `ease`
 * seconds (expo out) and then holds dead still. Returns a transform for a
 * wrapper around the whole frame.
 */
export function camera(t: number, keys: readonly Shot[], ease = 0.7) {
  let [_, x, y, s] = keys[0];
  for (let i = 1; i < keys.length; i++) {
    const [k, kx, ky, ks] = keys[i];
    if (t < k) break;
    const u = out(clamp01((t - k) / ease));
    // zoom in log space, position linear in screen space
    s = Math.exp(Math.log(s) + (Math.log(ks) - Math.log(s)) * u);
    x = x + (kx - x) * u;
    y = y + (ky - y) * u;
  }
  return { transformOrigin: "0 0", transform: `translate(${960 - x * s}px, ${540 - y * s}px) scale(${s})` };
}

// The measured gaps of streaming-text.html:240-256, seconds between words.
const GAPS = [0.167, 0.1, 0, 0.367, 0.1, 0.067, 0.2, 0.033, 0.133, 0.1, 0, 0.233, 0.067, 0.1];

/** Word timings of an agent reply that streams in uneven bursts from `start`. */
export function stream(text: string, start: number, speed = 1) {
  let at = start;
  return text.split(" ").map((word, i) => {
    const w = { word, at };
    at += (GAPS[i % GAPS.length] + 0.06) / speed;
    return w;
  });
}

/** Each streamed word inks from grey to full colour over 0.267 s. */
export const ink = (t: number, at: number) => clamp01((t - at) / 0.267);

/** Human typing (typed-prompt): 1–3 characters at a time, deterministic. */
export function typed(text: string, t: number, start: number, cps = 16) {
  if (t < start) return "";
  let shown = 0;
  let at = start;
  let i = 0;
  while (shown < text.length) {
    const chunk = 1 + ((i * 7 + 3) % 3);
    at += chunk / cps;
    if (t < at) break;
    shown += chunk;
    i++;
  }
  return text.slice(0, Math.min(shown, text.length));
}

/** Seconds a typed() line takes. */
export function typedLength(text: string, cps = 16) {
  let shown = 0, at = 0, i = 0;
  while (shown < text.length) { const chunk = 1 + ((i * 7 + 3) % 3); at += chunk / cps; shown += chunk; i++; }
  return at;
}

/** A press: the target dips to 0.94 over 0.1 s and returns over 0.22 s (physics-press-reaction). */
export function press(t: number, at: number) {
  const d = t - at;
  if (d < 0 || d > 0.32) return 1;
  return d < 0.1 ? 1 - 0.06 * (d / 0.1) : 0.94 + 0.06 * out((d - 0.1) / 0.22);
}
