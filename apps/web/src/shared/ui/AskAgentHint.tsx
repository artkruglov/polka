import React from "react";
import { Bot } from "lucide-react";
import { CopyButton } from "./CopyText.tsx";
import { OPEN_SHELF_PHRASE } from "../lib/known-shelf.ts";

/**
 * «Попросите агента: «Открой мою Полку»» (docs/specs/SIGN_IN_PROVIDERS.md
 * § 10): a connected agent hands out a one-time sign-in link. `lead` is what
 * comes before the phrase on this page; the phrase can be copied.
 */
export function AskAgentHint({
  lead = "Подключали Полку в Claude, ChatGPT или Codex? Попросите агента:",
  tail = "— он даст ссылку для входа.",
  className = "",
}: {
  lead?: string;
  tail?: string;
  className?: string;
}) {
  return (
    <p className={`ask-agent-hint ${className}`}>
      <Bot size={16} aria-hidden="true" />
      <span>
        {lead} <strong>«{OPEN_SHELF_PHRASE}»</strong> {tail}
      </span>
      <CopyButton
        value={OPEN_SHELF_PHRASE}
        label="Скопировать фразу"
        variant="quiet"
      />
    </p>
  );
}
