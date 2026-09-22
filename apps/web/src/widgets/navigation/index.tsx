import { authReturnTo } from "../../shared/lib/safe-next.ts";
import React, { useEffect, useState } from "react";
import {
  Bot,
  ChevronsUpDown,
  Compass,
  Home,
  LayoutTemplate,
  LogIn,
  LogOut,
  Plus,
} from "lucide-react";
import type { Account } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import { Avatar, Button } from "../../shared/ui/controls.tsx";
import { ActionMenu } from "../../shared/ui/ActionMenu.tsx";
import { Dialog } from "../../shared/ui/index.tsx";
export { useAccount } from "../../entities/account/model/useAccount.ts";

export type Section =
  | "landing"
  | "discover"
  | "shelf"
  | "bring"
  | "templates"
  | "connections";

export function SiteBrand() {
  return (
    <a className="brand site-brand" href="/" aria-label="Полка — главная">
      полка
    </a>
  );
}

// The same destinations on the desktop rail and the phone tab bar.
const links: {
  id: Section;
  label: string;
  href: string;
  icon: React.ComponentType<{ "aria-hidden"?: boolean | "true" }>;
}[] = [
  { id: "shelf", label: "Моя полка", href: "/", icon: Home },
  { id: "bring", label: "Сохранить", href: "/bring", icon: Plus },
  { id: "discover", label: "Интересное", href: "/discover", icon: Compass },
  { id: "templates", label: "Шаблоны", href: "/templates", icon: LayoutTemplate },
  { id: "connections", label: "Агенты", href: "/settings/agents", icon: Bot },
];

function useNarrow(query = "(max-width: 760px)") {
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia === "function" && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const list = matchMedia(query);
    const update = () => setNarrow(list.matches);
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return narrow;
}

/** Avatar + name at the bottom of the rail; leaving is a separate, confirmed action. */
export function AccountMenu({
  account,
  onLoggedOut,
}: {
  account: Account;
  onLoggedOut?: () => void;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const narrow = useNarrow();
  return (
    <>
      <ActionMenu
        label={`Аккаунт: ${account.name}`}
        className="site-account-menu"
        placement={narrow ? "end" : "start"}
        direction={narrow ? "down" : "up"}
        icon={
          <span className="site-account-trigger">
            <Avatar name={account.name} />
            <span className="site-account-name">{account.name}</span>
            <ChevronsUpDown aria-hidden="true" />
          </span>
        }
        items={[
          { id: "shelf", label: "Моя полка", icon: <Home />, onSelect: () => location.assign("/") },
          { id: "trash", label: "Корзина", onSelect: () => location.assign("/trash") },
          { id: "logout", label: "Выйти", icon: <LogOut />, tone: "danger", onSelect: () => setConfirm(true) },
        ]}
      />
      {confirm && (
        <Dialog title="Выйти из Полки?" onClose={() => !busy && setConfirm(false)} busy={busy}>
          <div className="dialog-body">
            <p>Сохранённые работы и ссылки останутся на месте. Чтобы вернуться, понадобятся логин и пароль.</p>
            {error && <p className="ui-field-error" role="alert">{error}</p>}
          </div>
          <div className="dialog-footer">
            <Button disabled={busy} onClick={() => setConfirm(false)}>Остаться</Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await client.logout();
                  setConfirm(false);
                  if (onLoggedOut) onLoggedOut();
                  else location.assign("/");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <LogOut /> Выйти
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function SiteHeader({
  current,
  account,
  children,
  actions,
  onLoggedOut,
}: {
  current: Section;
  account: Account | null | undefined;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  onLoggedOut?: () => void;
}) {
  const guest = account === null;
  const returnTo = authReturnTo(location);
  const hrefOf = (link: (typeof links)[number]) =>
    link.id === "shelf" && guest
      ? `/?login=1&next=${encodeURIComponent("/")}`
      : link.href;
  return (
    <>
      <header className="site-rail">
        <div className="site-rail-top">
          <SiteBrand />
          {actions && <div className="site-rail-actions">{actions}</div>}
        </div>
        <nav className="site-nav" aria-label="Основная навигация">
          {links.map((link) => (
            <a
              key={link.id}
              href={hrefOf(link)}
              aria-current={current === link.id ? "page" : undefined}
            >
              <link.icon aria-hidden="true" />
              {link.label}
              {link.id === "shelf" && guest && (
                <span className="sr-only"> — нужен вход</span>
              )}
            </a>
          ))}
        </nav>
        {children && <div className="navigation-context">{children}</div>}
        <div className="site-account">
          {account ? (
            <AccountMenu account={account} onLoggedOut={onLoggedOut} />
          ) : account === undefined ? (
            <span className="site-account-loading" role="status">
              Загрузка…
            </span>
          ) : (
            <a
              className="site-login"
              href={`/signup?next=${encodeURIComponent(returnTo)}`}
            >
              <LogIn /> Войти
            </a>
          )}
        </div>
      </header>
      <nav className="site-tabbar" aria-label="Основная навигация">
        {links.map((link) => {
          const Icon = link.icon;
          return (
            <a
              key={link.id}
              href={hrefOf(link)}
              aria-current={current === link.id ? "page" : undefined}
              data-primary={link.id === "bring" || undefined}
            >
              <Icon />
              <span>{link.label}</span>
            </a>
          );
        })}
      </nav>
    </>
  );
}

export function PrototypeMark({ children }: { children: React.ReactNode }) {
  return <span className="proto-mark">{children}</span>;
}

/** Owns the page inset and navigation. Pages only supply local content. */
export function AppShell({
  current,
  account,
  className = "",
  navigation,
  children,
  actions,
  onLoggedOut,
}: {
  current: Section;
  account: Account | null | undefined;
  className?: string;
  navigation?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  onLoggedOut?: () => void;
}) {
  return (
    <div className={`app-shell ${className}`}>
      <SiteHeader current={current} account={account} actions={actions} onLoggedOut={onLoggedOut}>
        {navigation}
      </SiteHeader>
      {children}
    </div>
  );
}
