import React from "react";
import { Link2 } from "lucide-react";
import type { LinkProvider } from "../../../../../packages/contracts/link-providers.ts";

/**
 * The badge of a link's service from Полка's own provider table: two letters
 * on the service's colour, never a brand logo. An unknown site gets a link icon.
 */
export function ServiceMark({
  provider,
  size = "md",
}: {
  provider: Pick<LinkProvider, "mark" | "color" | "name"> | null;
  size?: "md" | "lg";
}) {
  return (
    <span
      className={`service-mark service-mark--${size}`}
      style={provider ? { background: provider.color } : undefined}
      aria-hidden="true"
      data-service={provider ? provider.name : "site"}
    >
      {provider ? provider.mark : <Link2 />}
    </span>
  );
}
