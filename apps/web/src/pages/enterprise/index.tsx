import "./styles.css";
import React from "react";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { SiteHeader } from "../../widgets/site-header/index.tsx";
import { EnterpriseContent } from "./content.tsx";

export function Enterprise() {
  const account = useAccount();
  return (
    <AppShell current="landing" account={account} className="mkt-page" bare>
      <SiteHeader signedIn={!!account} />
      <main className="enterprise-page">
        <EnterpriseContent />
      </main>
    </AppShell>
  );
}
