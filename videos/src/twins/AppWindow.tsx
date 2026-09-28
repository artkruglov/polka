import React from "react";
import type { CSSProperties, ReactNode } from "react";
import { C, FONT, MONO } from "../brand/tokens";

/**
 * A browser window on the product's surfaces (skill: app surfaces), holding a
 * screen drawn at the app's own size and scaled for 1080p. No invented shades:
 * canvas, soft toolbar, 1px line.
 */
export function AppWindow({ x, y, width, height, scale, address, children, style }: {
  x: number; y: number; width: number; height: number; scale: number; address: string; children: ReactNode; style?: CSSProperties;
}) {
  const bar = 44;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: width * scale, height: (height + bar) * scale, ...style }}>
      <div style={{ width, height: height + bar, scale: String(scale), transformOrigin: "0 0", borderRadius: 12, border: `1px solid ${C.lineStrong}`,
        background: C.canvas, overflow: "hidden", boxShadow: "0 20px 60px rgb(22 36 67/16%)", fontFamily: FONT }}>
        <div style={{ height: bar, display: "flex", alignItems: "center", gap: 14, padding: "0 16px", background: C.soft, borderBottom: `1px solid ${C.line}` }}>
          <span style={{ display: "flex", gap: 7 }}>
            {["#e7ebf1", "#e7ebf1", "#e7ebf1"].map((c, i) => <i key={i} style={{ width: 11, height: 11, borderRadius: 99, background: c, border: `1px solid ${C.lineStrong}` }} />)}
          </span>
          <span style={{ flex: 1, maxWidth: 520, margin: "0 auto", height: 28, display: "flex", alignItems: "center", padding: "0 12px",
            borderRadius: 8, background: C.canvas, border: `1px solid ${C.line}`, color: C.muted, font: `400 13px/1 ${MONO}` }}>{address}</span>
          <span style={{ width: 47 }} />
        </div>
        <div style={{ position: "relative", height, overflow: "hidden" }}>{children}</div>
      </div>
    </div>
  );
}
