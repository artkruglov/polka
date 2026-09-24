import "./styles.css";
import React from "react";
import privacy from "../../../../../docs/legal/privacy.md?raw";
import terms from "../../../../../docs/legal/terms.md?raw";
import bot from "../../../../../docs/legal/bot.md?raw";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { Markdown } from "./markdown.tsx";

// The reviewed Markdown in docs/legal is the only copy of these texts.
// bot.md: what PolkaRenderer is, for site owners (the User-Agent names /bot).
const texts = { privacy, terms, bot } as const;

export function LegalPage({ doc }: { doc: keyof typeof texts }) {
  const account = useAccount();
  return (
    <AppShell current="landing" account={account}>
      <main className="legal-page">
        <article className="legal-text">
          <Markdown source={texts[doc]} />
        </article>
      </main>
    </AppShell>
  );
}

export const PrivacyPage = () => <LegalPage doc="privacy" />;
export const TermsPage = () => <LegalPage doc="terms" />;
export const BotPage = () => <LegalPage doc="bot" />;
