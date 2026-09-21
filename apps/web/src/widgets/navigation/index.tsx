import { authReturnTo } from "../../shared/lib/safe-next.ts";
import React from "react";
import { Compass, LayoutGrid, LogIn, Plus, Send } from "lucide-react";
import type { Account } from "../../../../../packages/contracts/index.ts";
export { useAccount } from "../../entities/account/model/useAccount.ts";

export type Section =
  "landing" | "discover" | "shelf" | "bring" | "connections";

export function SiteBrand() {
  return (
    <a className="brand site-brand" href="/" aria-label="Полка — главная">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      полка
    </a>
  );
}

// Keep the main destinations in the same order as the personal shelf.
const links: {
  id: Section;
  label: string;
  href: string;
  icon: React.ComponentType<{ "aria-hidden"?: boolean | "true" }>;
}[] = [
  { id: "shelf", label: "Моя Полка", href: "/", icon: LayoutGrid },
  { id: "bring", label: "Сохранить", href: "/bring", icon: Plus },
  { id: "discover", label: "Интересное", href: "/discover", icon: Compass },
  { id: "connections", label: "Агенты", href: "/settings/agents", icon: Send },
];

export function SiteHeader({
  current,
  account,
  children,
  actions,
}: {
  current: Section;
  account: Account | null | undefined;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const guest = account === null;
  const returnTo = authReturnTo(location);
  const hrefOf = (link: (typeof links)[number]) =>
    link.id === "shelf" && guest
      ? `/?login=1&next=${encodeURIComponent("/")}`
      : link.href;
  return (
    <>
      <header className="site-header unified-navigation">
        <SiteBrand />
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
          {actions}
          {account ? (
            <a
              className="site-avatar"
              href="/"
              aria-label={`Моя Полка — ${account.name}`}
            >
              {account.name.slice(0, 1).toUpperCase()}
            </a>
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
}: {
  current: Section;
  account: Account | null | undefined;
  className?: string;
  navigation?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className={`app-shell ${className}`}>
      <SiteHeader current={current} account={account} actions={actions}>
        {navigation}
      </SiteHeader>
      {children}
    </div>
  );
}
