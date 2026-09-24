import React from "react";
import { Button } from "../../shared/ui/controls.tsx";

/**
 * Route-level code splitting: each page below is its own chunk, so the first
 * screen downloads only what it shows. Zod and the editorial client stay out of
 * the initial chunk because only lazy pages import them.
 */
const page = <T extends React.ComponentType>(load: () => Promise<T>) =>
  React.lazy(() => load().then((component) => ({ default: component })));

const Templates = page(() =>
  import("../../pages/templates/index.tsx").then((m) => m.Templates),
);
const Signup = page(() =>
  import("../../pages/signup/index.tsx").then((m) => m.Signup),
);
const SignupChoose = page(() =>
  import("../../pages/signup/choose.tsx").then((m) => m.SignupChoose),
);
const SignupLinked = page(() =>
  import("../../pages/signup/choose.tsx").then((m) => m.SignupLinked),
);
const Claim = page(() =>
  import("../../pages/claim/index.tsx").then((m) => m.Claim),
);
const Enter = page(() =>
  import("../../pages/enter/index.tsx").then((m) => m.Enter),
);
const SignIn = page(() =>
  import("../../pages/enter/signin.tsx").then((m) => m.SignIn),
);
const FirstSave = page(() =>
  import("../../pages/start/index.tsx").then((m) => m.FirstSave),
);
const AgentConnections = page(() =>
  import("../../pages/agents/index.tsx").then((m) => m.AgentConnections),
);
const Recipient = page(() =>
  import("../../pages/recipient/index.tsx").then((m) => m.Recipient),
);
const Bring = page(() =>
  import("../../pages/bring/index.tsx").then((m) => m.Bring),
);
const Landing = page(() =>
  import("../../pages/landing/index.tsx").then((m) => m.Landing),
);
const EditorialPage = page(() =>
  import("../../pages/discover/index.tsx").then((m) => m.EditorialPage),
);
const LibraryInvite = page(() =>
  import("../../pages/library-invite/index.tsx").then((m) => m.LibraryInvite),
);
const Moderation = page(() =>
  import("../../pages/moderation/index.tsx").then((m) => m.Moderation),
);
const Away = page(() =>
  import("../../pages/away/index.tsx").then((m) => m.Away),
);
const MailOff = page(() =>
  import("../../pages/mail-off/index.tsx").then((m) => m.MailOff),
);
const PrivacyPage = page(() =>
  import("../../pages/legal/index.tsx").then((m) => m.PrivacyPage),
);
const TermsPage = page(() =>
  import("../../pages/legal/index.tsx").then((m) => m.TermsPage),
);
const Pricing = page(() =>
  import("../../pages/pricing/index.tsx").then((m) => m.Pricing),
);
const Enterprise = page(() =>
  import("../../pages/enterprise/index.tsx").then((m) => m.Enterprise),
);
const OAuthConsent = page(() =>
  import("../../pages/oauth-consent/index.tsx").then((m) => m.OAuthConsent),
);

/** A chunk that fails to load (offline, or replaced by a new release) gets a reload, not a blank page. */
class ChunkBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty" role="alert">
        <h1>Страница не загрузилась</h1>
        <p>
          Проверьте подключение или обновите страницу: возможно, Полка
          обновилась.
        </p>
        <Button variant="primary" onClick={() => location.reload()}>
          Обновить страницу
        </Button>
      </div>
    );
  }
}

export function Lazy({ children }: { children: React.ReactNode }) {
  return (
    <ChunkBoundary>
      <React.Suspense
        fallback={
          <div className="empty" role="status">
            Загружаем…
          </div>
        }
      >
        {children}
      </React.Suspense>
    </ChunkBoundary>
  );
}

export const LazyLanding = () => (
  <Lazy>
    <Landing />
  </Lazy>
);

export {
  Templates,
  Signup,
  FirstSave,
  AgentConnections,
  Recipient,
  Bring,
  Landing,
  EditorialPage,
  LibraryInvite,
  Moderation,
  OAuthConsent,
  Away,
  MailOff,
  PrivacyPage,
  TermsPage,
  Pricing,
  Enterprise,
  SignupChoose,
  SignupLinked,
  Claim,
  Enter,
  SignIn,
};
