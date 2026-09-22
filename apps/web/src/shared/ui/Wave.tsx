import React, { useId } from "react";

/** Brand motif: soft blue-violet waves. Decorative only. */
export function Wave({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const id = useId();
  const a = `${id}-a`, b = `${id}-b`;
  return (
    <svg
      className={`polka-wave ${className}`}
      viewBox={compact ? "0 0 900 120" : "0 0 1200 180"}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={a} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#dbe5ff" />
          <stop offset=".5" stopColor="#c7d6ff" />
          <stop offset="1" stopColor="#e6ddff" />
        </linearGradient>
        <linearGradient id={b} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#1f4fff" stopOpacity=".55" />
          <stop offset=".6" stopColor="#7b8cff" stopOpacity=".5" />
          <stop offset="1" stopColor="#b48cff" stopOpacity=".35" />
        </linearGradient>
      </defs>
      {compact ? (
        <>
          <path d="M0 78 C150 -10 260 140 450 62 S760 0 900 48 L900 84 C700 24 620 140 420 78 S140 30 0 96Z" fill={`url(#${a})`} />
          <path d="M0 90 C170 70 230 -8 400 40 S620 130 900 26" fill="none" stroke={`url(#${b})`} strokeWidth="1.4" />
          <path d="M0 104 C220 40 290 22 470 66 S740 60 900 14" fill="none" stroke="#c9d5ff" strokeWidth="1" />
        </>
      ) : (
        <>
          <path d="M0 120 C200 -20 340 210 600 90 S1010 0 1200 70 L1200 128 C930 40 820 210 560 118 S190 50 0 150Z" fill={`url(#${a})`} />
          <path d="M0 136 C230 100 300 -10 540 58 S830 200 1200 40" fill="none" stroke={`url(#${b})`} strokeWidth="1.6" />
          <path d="M0 158 C300 60 380 30 640 96 S990 90 1200 24" fill="none" stroke="#c9d5ff" strokeWidth="1" />
        </>
      )}
    </svg>
  );
}
