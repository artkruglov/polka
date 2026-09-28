import React from "react";
import { C } from "./tokens";
import { clamp01 } from "../kit/time";

/**
 * The mark of Полка (apps/web/public/favicon.svg) drawn from time: the blue
 * tile grows in, the arch then the shelf line draw with their round caps.
 * `draw` 0..1 covers the whole build; 0 is an empty frame, so a loop can end
 * where it began.
 */
const ARCH = 21 + 22 + 21; // M21 42V21h22v21
const SHELF = 38; // M13 50h38

export function Mark({ size, draw }: { size: number; draw: number }) {
  const tile = clamp01(draw / 0.35);
  const arch = clamp01((draw - 0.3) / 0.45);
  const shelf = clamp01((draw - 0.62) / 0.38);
  const ease = (u: number) => 1 - Math.pow(1 - u, 3);
  const s = ease(tile);
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: "block", overflow: "visible" }}>
      <rect x={32 - 32 * s} y={32 - 32 * s} width={64 * s} height={64 * s} rx={14 * s} fill={C.accent} opacity={tile > 0 ? 1 : 0} />
      <path d="M21 42V21h22v21" fill="none" stroke="#fff" strokeWidth={7} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={ARCH} strokeDashoffset={ARCH * (1 - ease(arch))} opacity={arch > 0 ? 1 : 0} />
      <path d="M13 50h38" fill="none" stroke="#fff" strokeWidth={4.5} strokeLinecap="round"
        strokeDasharray={SHELF} strokeDashoffset={SHELF * (1 - ease(shelf))} opacity={shelf > 0 ? 1 : 0} />
    </svg>
  );
}
