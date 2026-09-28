import React from "react";
import { Wave } from "../../../apps/web/src/shared/ui/Wave.tsx";
import { Mark } from "./Mark";
import { clamp01 } from "../kit/time";

/** The brand wave, calm along the bottom; thinned while big words are on screen. */
export function WaveBand({ t, words, duration }: { t: number; words: readonly (readonly [number, number])[]; duration: number }) {
  let thin = 0;
  for (const [start, out] of words) thin = Math.max(thin, clamp01((t - start + 0.3) / 0.3) * (1 - clamp01((t - out) / 0.3)));
  const drift = Math.sin((t / duration) * Math.PI * 2) * 40;
  return (
    <div style={{ position: "absolute", left: -60 + drift, right: -60 - drift, bottom: -10, height: 220, opacity: 0.9 - thin * 0.5 }}>
      <Wave />
      <style>{".polka-wave{display:block;width:100%;height:100%}"}</style>
    </div>
  );
}

/**
 * The mark: draws itself big in the first bar, steps up above the first line,
 * leaves with it; comes back above the closing line and undraws to an empty
 * frame at the end, so the loop's last frame equals its first.
 */
export function MarkLayer({ t, draw: [s0, s1], firstWord, firstOut, end: [e0, e1] }: {
  t: number; draw: readonly [number, number]; firstWord: number; firstOut: number; end: readonly [number, number];
}) {
  const opening = t < firstOut + 0.3;
  const closing = t >= e0 - 0.1;
  if (!opening && !closing) return null;
  let draw = clamp01((t - s0) / (s1 - s0));
  if (closing) draw = t < e1 - 0.9 ? 1 : 1 - clamp01((t - (e1 - 0.9)) / 0.8);
  const leave = opening ? clamp01((t - firstOut) / 0.2) : 0;
  const enter = closing ? clamp01((t - (e0 - 0.1)) / 0.3) : 1;
  const lift = opening ? clamp01((t - firstWord + 0.35) / 0.35) : 1;
  const size = 200 - lift * 64;
  const y = 470 - lift * 110;
  return (
    <div style={{ position: "absolute", left: 960 - size / 2, top: y - size / 2, opacity: (1 - leave) * enter }}>
      <Mark size={size} draw={draw} />
    </div>
  );
}
