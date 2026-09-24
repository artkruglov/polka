import React from "react";
import type { EditorialPublicResponse } from "../../../../../packages/editorial.ts";

// A typographic cover drawn from the item itself: its title and topic, with a
// tone and motif chosen by its slug so it is stable between visits. Decorative
// only — not a screenshot of the material.
const tones = ["night", "blue", "peach", "paper", "green"] as const;
const motifs = ["matrix", "dots", "tiles", "bars", "pages", "city"] as const;

function hash(value: string) {
  let h = 0;
  for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function EditorialArtwork({
  item,
}: {
  item: Pick<EditorialPublicResponse, "slug" | "title" | "topic">;
}) {
  const h = hash(item.slug);
  const tone = tones[h % tones.length];
  const motif = motifs[Math.floor(h / tones.length) % motifs.length];
  return (
    <div className={`editorial-art art-${tone}`} aria-hidden="true">
      <span className="art-edition">ПОЛКА / РЕДАКЦИЯ</span>
      <strong>{item.title}</strong>
      <span className="art-caption">{item.topic}</span>
      <svg viewBox="0 0 480 320" preserveAspectRatio="xMidYMid slice">
        {/* The motif keeps to the right 40% of the cover; the title has the
            left half (styles.css), so the two never overlap. */}
        <g transform="translate(118 44) scale(0.72)">
        {motif === "dots" && Array.from({ length: 21 }, (_, i) => <circle key={i} cx={265 + (i % 5) * 40} cy={75 + Math.floor(i / 5) * 45} r={14 + (i % 3) * 3} fill="currentColor" opacity={0.25 + (i % 4) * 0.2} />)}
        {motif === "matrix" && Array.from({ length: 16 }, (_, i) => <rect key={i} x={255 + (i % 4) * 48} y={77 + Math.floor(i / 4) * 48} width="36" height="36" rx="7" fill="currentColor" opacity={0.12 + (i % 5) * 0.18} transform="rotate(-12 345 165)" />)}
        {motif === "tiles" && Array.from({ length: 20 }, (_, i) => <path key={i} d={`M ${240 + (i % 4) * 55} ${40 + Math.floor(i / 4) * 55} h 50 v 50 a 50 50 0 0 1 -50 -50`} fill="currentColor" opacity={0.2 + (i % 3) * 0.3} />)}
        {motif === "bars" && [70, 130, 95, 185, 155, 230].map((height, i) => <rect key={i} x={247 + i * 35} y={285 - height} width="25" height={height} rx="6" fill="currentColor" opacity={0.22 + i * 0.13} />)}
        {motif === "pages" && [0, 1, 2].map((i) => <g key={i} transform={`translate(${240 + i * 24},${90 + i * 15}) rotate(${i * 9 - 12})`}><rect width="140" height="190" rx="6" fill="currentColor" opacity={0.25 + i * 0.22} /><path d="M20 36h95M20 56h95M20 76h65" stroke="var(--art-bg)" strokeWidth="5" /></g>)}
        {motif === "city" && [130, 210, 170, 250, 110].map((height, i) => <g key={i}><rect x={245 + i * 44} y={300 - height} width="34" height={height} fill="currentColor" opacity={0.3 + i * 0.12} />{[0, 1, 2, 3].map((j) => <path key={j} d={`M${253 + i * 44} ${310 - height + j * 23}h17`} stroke="var(--art-bg)" strokeWidth="5" />)}</g>)}
        </g>
      </svg>
    </div>
  );
}
