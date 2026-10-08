import React from "react";
import { App } from "../workspace/index.tsx";
import { useDocumentTitle } from "../../shared/lib/document-title.ts";
import { routeTitle } from "./titles.ts";
import { isAppPage } from "../../../../../packages/contracts/app-routes.ts";
import {
  NotFound,
  AgentConnections,
  AgentSessions,
  Away,
  Bring,
  BringReceive,
  BookmarkletPage,
  EditorialPage,
  Enterprise,
  CompanyAdmin,
  FirstSave,
  Landing,
  Lazy,
  MailOff,
  AccountDeleted,
  LibraryInvite,
  ShelfInvite,
  ShelfSnapshotPage,
  Moderation,
  OAuthConsent,
  Pricing,
  PrivacyPage,
  BotPage,
  Recipient,
  Signup,
  SignupChoose,
  SignupLinked,
  Claim,
  Enter,
  SignIn,
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
  // The same list the server serves the shell for (packages/contracts/app-routes.ts).
  if (!isAppPage(path)) return <NotFound />;
  if (path === "/templates") return <Templates />;
  if (path === "/library-invite") return <LibraryInvite />;
  if (path === "/shelf-invite") return <ShelfInvite />;
  if (path === "/snapshot") return <ShelfSnapshotPage />;
  if (path === "/oauth/consent") return <OAuthConsent />;
  if (path === "/moderation") return <Moderation />;
  if (path === "/signup") return <Signup />;
  if (path === "/signup/choose") return <SignupChoose />;
  if (path === "/signup/linked") return <SignupLinked />;
  if (path === "/claim") return <Claim />;
  if (path === "/enter") return <Enter />;
  if (path === "/signin") return <SignIn />;
  if (path === "/privacy") return <PrivacyPage />;
  if (path === "/terms") return <TermsPage />;
  if (path === "/bot") return <BotPage />;
  if (path === "/pricing") return <Pricing />;
  if (path === "/enterprise") return <Enterprise />;
  if (path === "/start") return <FirstSave />;
  // «Настройки»: agents, sign-in methods, deleting the shelf.
  if (path === "/settings" || path === "/settings/agents" || path === "/connections")
    return <AgentConnections />;
  if (path === "/settings/company") return <CompanyAdmin />;
  // Agent sessions: the list, «Секреты», «Расход» and one session.
  if (path === "/sessions" || path.startsWith("/sessions/")) return <AgentSessions />;
  if (path === "/s") return <Recipient />;
  if (path === "/away") return <Away />;
  if (path === "/mail-off") return <MailOff />;
  if (path === "/account-deleted") return <AccountDeleted />;
  // The guest landing, also for people who are signed in.
  if (path === "/landing") return <Landing />;
  if (path.startsWith("/discover")) return <EditorialPage />;
  if (path === "/bring/receive") return <BringReceive />;
  if (path === "/bookmarklet") return <BookmarkletPage />;
  if (path.startsWith("/bring")) return <Bring />;
  return null;
}

export function AppRoutes({ path = location.pathname }: { path?: string }) {
  useDocumentTitle(routeTitle(path));
  const route = Route({ path });
  // The workspace («/», /works/…, /trash) stays in the initial chunk: it is the most common entry.
  return route ? <Lazy>{route}</Lazy> : <App />;
}
