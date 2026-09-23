import "./styles.css";
import React from "react";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { EnterpriseContent } from "./content.tsx";

export function Enterprise() {
  const account = useAccount();
  return (
    <AppShell current="landing" account={account}>
      <main className="enterprise-page">
        <EnterpriseContent />
      </main>
    </AppShell>
  );
}
