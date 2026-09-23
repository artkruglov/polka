import React from "react";
import { App } from "../workspace/index.tsx";
import {
  AgentConnections,
  Away,
  Bring,
  EditorialPage,
  FirstSave,
  Landing,
  Lazy,
  MailOff,
  LibraryInvite,
  Moderation,
  OAuthConsent,
  Pricing,
  PrivacyPage,
  Recipient,
  Signup,
  Templates,
  TermsPage,
} from "./lazy-pages.tsx";

// The development inventory never enters the production bundle.
const ComponentCatalog = import.meta.env.DEV
  ? React.lazy(() =>
      import("../../pages/component-catalog/index.tsx").then((module) => ({
        default: module.ComponentCatalog,
      })),
    )
  : null;

function Route({ path }: { path: string }) {
  if (path === "/dev/components" && ComponentCatalog)
    return <ComponentCatalog />;
  if (path === "/templates") return <Templates />;
  if (path === "/library-invite") return <LibraryInvite />;
  if (path === "/oauth/consent") return <OAuthConsent />;
  if (path === "/moderation") return <Moderation />;
  if (path === "/signup") return <Signup />;
  if (path === "/privacy") return <PrivacyPage />;
  if (path === "/terms") return <TermsPage />;
  if (path === "/pricing") return <Pricing />;
  if (path === "/start") return <FirstSave />;
  if (path === "/settings/agents" || path === "/connections")
    return <AgentConnections />;
  if (path === "/s") return <Recipient />;
  if (path === "/away") return <Away />;
  if (path === "/mail-off") return <MailOff />;
  // The guest landing, also for people who are signed in.
  if (path === "/landing") return <Landing />;
  if (path.startsWith("/discover")) return <EditorialPage />;
  if (path.startsWith("/bring")) return <Bring />;
  return null;
}

export function AppRoutes({ path = location.pathname }: { path?: string }) {
  const route = Route({ path });
  // The workspace («/», /works/…, /trash) stays in the initial chunk: it is the most common entry.
  return route ? <Lazy>{route}</Lazy> : <App />;
}
