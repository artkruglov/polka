import { Badge } from "./controls.tsx";
import React from "react";

export type Readiness = "real" | "demo" | "plan" | "unsupported";

export const readinessLabel: Record<Readiness, string> = {
  real: "работает",
  demo: "демо",
  plan: "в плане",
  unsupported: "не поддерживается",
};

/** One honest status word next to every feature: what works today, what is a browser demo, what is planned. */
export function Status({ is }: { is: Readiness }) {
  return (
    <Badge tone={is === "real" ? "success" : is === "demo" ? "warning" : is === "unsupported" ? "danger" : "neutral"} data-status={is}>
      {readinessLabel[is]}
    </Badge>
  );
}

export function StatusRibbon({
  items,
  label = "Что работает сейчас",
}: {
  items: { is: Readiness; text: string }[];
  label?: string;
}) {
  return (
    <ul className="status-ribbon" aria-label={label}>
      {items.map((item) => (
        <li key={item.text}>
          <Status is={item.is} /> {item.text}
        </li>
      ))}
    </ul>
  );
}
