import "./styles.css";
import React from "react";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { SiteHeader } from "../../widgets/site-header/index.tsx";
import { PricingPlans } from "./plans.tsx";

export function Pricing() {
  const account = useAccount();
  return (
    <AppShell current="landing" account={account} className="mkt-page" bare>
      <SiteHeader signedIn={!!account} />
      <main className="pricing-page">
        <PricingPlans />
      </main>
    </AppShell>
  );
}
