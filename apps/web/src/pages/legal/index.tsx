import "./styles.css";
import React, { useEffect } from "react";
import privacy from "../../../../../docs/legal/privacy.md?raw";
import terms from "../../../../../docs/legal/terms.md?raw";
import bot from "../../../../../docs/legal/bot.md?raw";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { useCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import { Markdown } from "./markdown.tsx";
import { OperatorDocument, OperatorLink, legalView, type LegalDoc } from "./installation.tsx";

// The reviewed Markdown in docs/legal is the only copy of these texts, and
// they are polochka.app's: another installation shows its operator's
// (installation.tsx). bot.md: what PolkaRenderer is, for site owners (the
// User-Agent names /bot).
const texts: Record<LegalDoc, string> = { privacy, terms, bot };

export function LegalPage({ doc }: { doc: LegalDoc }) {
  const account = useAccount();
  const view = legalView(doc, useCapabilities());
  const target = view.kind === "redirect" ? view.url : null;
  useEffect(() => {
    if (target) location.replace(target);
  }, [target]);
  return (
    <AppShell current="landing" account={account}>
      <main id="main" className="legal-page" aria-busy={view.kind === "loading" || undefined}>
        <article className="legal-text">
          {view.kind === "text" && <Markdown source={texts[doc]} />}
          {view.kind === "redirect" && doc !== "bot" && <OperatorLink doc={doc} url={view.url} />}
          {view.kind === "operator" && doc !== "bot" && (
            <OperatorDocument doc={doc} operatorName={view.operatorName} contact={view.contact} />
          )}
        </article>
      </main>
    </AppShell>
  );
}

export const PrivacyPage = () => <LegalPage doc="privacy" />;
export const TermsPage = () => <LegalPage doc="terms" />;
export const BotPage = () => <LegalPage doc="bot" />;
