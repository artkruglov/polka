import React from "react";
import { AGENTS, FONT, type AgentId } from "./tokens";

/** ServiceMark (apps/web/src/shared/ui/ServiceMark.tsx): two letters on the service's colour, never a brand logo. */
export function AgentMark({ agent, size = 44 }: { agent: AgentId; size?: number }) {
  const a = AGENTS[agent];
  return (
    <span style={{ display: "inline-grid", placeItems: "center", width: size, height: size, flex: "none", borderRadius: size * 0.28,
      background: a.color, color: "#fff", font: `600 ${size * 0.4}px/1 ${FONT}`, letterSpacing: "-.02em" }}>
      {a.mark}
    </span>
  );
}
