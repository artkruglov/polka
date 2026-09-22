import React from "react";
import { hueOf } from "../../entities/artifact/format.ts";

/**
 * A cover for materials without an image of their own: the title set large on a soft
 * gradient with the brand wave. The gradient follows the material id, so it stays the
 * same between visits and differs between neighbours.
 */
export function TextCover({
  id,
  title,
  eyebrow,
  note,
  compact = false,
}: {
  id: string;
  title: string;
  eyebrow: string;
  note?: string;
  compact?: boolean;
}) {
  const hue = hueOf(id);
  const style = {
    "--cover-hue": hue,
    background: `linear-gradient(135deg, hsl(${hue} 60% 96%) 0%, hsl(${(hue + 30) % 360} 70% 91%) 55%, hsl(${(hue + 60) % 360} 65% 86%) 100%)`,
  } as React.CSSProperties;
  return (
    <div className={`text-cover${compact ? " text-cover--compact" : ""}`} style={style} aria-hidden="true">
      <span className="text-cover-eyebrow">{eyebrow}</span>
      <strong className="text-cover-title">{title}</strong>
      {note && <span className="text-cover-note">{note}</span>}
      <svg className="text-cover-wave" viewBox="0 0 400 120" preserveAspectRatio="none">
        <path d="M0 80 C60 20 110 120 190 70 S320 10 400 60 L400 120 L0 120Z" fill={`hsl(${hue} 70% 60% / .18)`} />
        <path d="M0 96 C80 60 130 130 220 84 S330 30 400 74" fill="none" stroke={`hsl(${hue} 80% 55% / .55)`} strokeWidth="1.5" />
        <path d="M0 108 C90 80 160 20 250 66 S350 96 400 40" fill="none" stroke={`hsl(${(hue + 40) % 360} 70% 60% / .35)`} strokeWidth="1" />
      </svg>
    </div>
  );
}
