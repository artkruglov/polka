import React from "react";
import type { Account } from "../../../../../packages/contracts/index.ts";
import { rememberAccount, useAccountState } from "../../entities/account/model/useAccount.ts";
import { knownShelf } from "../../shared/lib/known-shelf.ts";
import { loadOnce } from "../../shared/lib/load-once.ts";
import { safeNext } from "../../shared/lib/safe-next.ts";
import { Button } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { Lazy, LazyLanding, preloadLanding } from "../routing/lazy-pages.tsx";

/**
 * «/», /works/… and /trash. This gate stays in the initial chunk and only
 * asks who is here; the workspace (index.tsx, with its dialogs and features)
 * and the sign-in form are chunks of their own, so the landing and every
 * other page never download them (tests/web-entry-chunk.test.ts).
 */
const params = new URLSearchParams(location.search);
const guestHome = location.pathname === "/" && !params.has("login");

const loadWorkspace = loadOnce(() => import("./index.tsx"));
const Workspace = React.lazy(() => loadWorkspace().then((module) => ({ default: module.App })));
const Login = React.lazy(() => import("../../pages/login/index.tsx").then((module) => ({ default: module.Login })));

/**
 * Started with the entry, beside /api/session, not after it: «/» for a guest
 * is the landing; a work, the trash, or «/» in a browser that signed in
 * before is most likely the workspace.
 */
export function preloadHome(path = location.pathname) {
  if (path !== "/" && !path.startsWith("/works/") && path !== "/trash") return;
  if (path !== "/" || !guestHome || knownShelf()) void loadWorkspace().catch(() => undefined);
  if (guestHome && path === "/") preloadLanding();
}

function resume(next: string) {
  const intent = params.get("intent");
  location.replace(intent && !/[?#]/.test(next) ? `${next}?intent=${encodeURIComponent(intent)}` : next);
}

export function Home() {
  const { account, error: authError, retry } = useAccountState();
  // The landing page is static: a guest (or an unreachable API) should still see it.
  if (guestHome && (account === null || authError)) return <LazyLanding />;
  if (authError)
    return (
      <main id="main" className="empty">
        <h1>Не удалось соединиться с Полкой</h1>
        <ErrorNotice error={authError} />
        <Button onClick={retry}>Попробовать снова</Button>
      </main>
    );
  if (account === undefined)
    return (
      <div className="empty" role="status">
        Открываем полку…
      </div>
    );
  if (!account)
    return (
      <Lazy>
        <Login
          onLogin={(a: Account) => {
            const next = safeNext(params.get("next"));
            if (next && next !== "/") return resume(next);
            window.history.replaceState(null, "", location.pathname);
            rememberAccount(a);
          }}
        />
      </Lazy>
    );
  const nextAfterLogin = safeNext(params.get("next"));
  if (params.has("login") && nextAfterLogin && nextAfterLogin !== "/") {
    resume(nextAfterLogin);
    return (
      <div className="empty" role="status">
        Возвращаем к действию…
      </div>
    );
  }
  return (
    <Lazy>
      <Workspace account={account} />
    </Lazy>
  );
}
