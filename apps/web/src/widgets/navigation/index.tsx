import { authReturnTo } from "../../shared/lib/safe-next.ts";
import React, { useEffect, useState } from "react";
import {
  Bot,
  ChevronsUpDown,
  CodeXml,
  Compass,
  Home,
  LayoutTemplate,
  LogIn,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
import type { Account } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import { Avatar, Button, IconButton } from "../../shared/ui/controls.tsx";
import { ActionMenu } from "../../shared/ui/ActionMenu.tsx";
import { Dialog } from "../../shared/ui/index.tsx";
import {
  rememberAccount,
  useAccountState,
} from "../../entities/account/model/useAccount.ts";
import {
  useSignInWays,
  useSourceUrl,
} from "../../entities/capabilities/useCapabilities.ts";
import { useSourceStars } from "../../entities/capabilities/useSourceStars.ts";
import { GitHubMark } from "../../shared/ui/GitHubMark.tsx";
import { formatStars, onGitHub } from "../../shared/lib/project-links.ts";
import {
  OPEN_SHELF_PHRASE,
  takeEnteredByAgent,
  takeFreshShelfNote,
} from "../../shared/lib/known-shelf.ts";
export { useAccount } from "../../entities/account/model/useAccount.ts";

/**
 * The source code in the header, the way open-source products show it: the
 * GitHub mark, and the star count once there is one worth showing. The count
 * comes from this server (GET /api/source/stars), never from GitHub directly.
 */
function SourceLink() {
  const sourceUrl = useSourceUrl();
  const stars = formatStars(useSourceStars());
  const github = onGitHub(sourceUrl);
  return (
    <a
      className="site-github"
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={
        github
          ? `Открытый код на GitHub${stars ? `, ${stars} звёзд` : ""}`
          : "Открытый код"
      }
    >
      {github ? <GitHubMark size={20} /> : <CodeXml aria-hidden="true" />}
      <span className="site-github-label">
        {github ? "GitHub" : "Открытый код"}
      </span>
      {stars && (
        <span className="site-github-stars" aria-hidden="true">
          ★ {stars}
        </span>
      )}
    </a>
  );
}

export type Section =
  | "landing"
  | "discover"
  | "shelf"
  | "bring"
  | "templates"
  | "connections";

function SiteBrand() {
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
  { id: "discover", label: "Лента", href: "/discover", icon: Compass },
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
function AccountMenu({
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
            <p>
              {account.provisional
                ? `Полка временная и живёт в этом браузере. Вернуться в неё можно по ссылке от агента («${OPEN_SHELF_PHRASE}») — или закрепите её перед выходом.`
                : "Сохранённые работы и ссылки останутся на месте. Чтобы вернуться, войдите снова."}
            </p>
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
                  rememberAccount(null);
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

/**
 * A page that reads (the owner's work) folds the desktop rail to icons. The
 * choice is this browser's convenience: blocked storage keeps it folded.
 */
const RAIL_KEY = "polka:rail:expanded";
function readRailExpanded() {
  try {
    return localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}
function writeRailExpanded(expanded: boolean) {
  try {
    if (expanded) localStorage.setItem(RAIL_KEY, "1");
    else localStorage.removeItem(RAIL_KEY);
  } catch {
    // Not remembered; the rail still switches for this visit.
  }
}

function SiteHeader({
  current,
  account,
  children,
  actions,
  onLoggedOut,
  collapsed = false,
  onToggleRail,
}: {
  current: Section;
  account: Account | null | undefined;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  onLoggedOut?: () => void;
  /** Folded to icons (only where `onToggleRail` is given). */
  collapsed?: boolean;
  onToggleRail?: () => void;
}) {
  const guest = account === null;
  // Guests see the source everywhere; people with a shelf see it on the landing.
  const showSource = guest || current === "landing";
  const returnTo = authReturnTo(location);
  // Shares the cached /me request; shown only when the page has no account yet.
  const accountCheck = useAccountState();
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
          {onToggleRail && (
            <IconButton
              size="sm"
              className="site-rail-toggle"
              label={collapsed ? "Развернуть меню" : "Свернуть меню"}
              aria-expanded={!collapsed}
              onClick={onToggleRail}
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </IconButton>
          )}
        </div>
        <nav className="site-nav" aria-label="Разделы">
          {links.map((link) => (
            <a
              key={link.id}
              href={hrefOf(link)}
              aria-current={current === link.id ? "page" : undefined}
              title={collapsed ? link.label : undefined}
            >
              <link.icon aria-hidden="true" />
              <span className="site-nav-label">{link.label}</span>
              {link.id === "shelf" && guest && (
                <span className="sr-only"> — нужен вход</span>
              )}
            </a>
          ))}
        </nav>
        {showSource && (
          <div className="site-source">
            <SourceLink />
          </div>
        )}
        {children && <div className="navigation-context">{children}</div>}
        <div className="site-account">
          {account ? (
            <AccountMenu account={account} onLoggedOut={onLoggedOut} />
          ) : account === undefined && accountCheck.error ? (
            <Button variant="quiet" onClick={accountCheck.retry}>
              Нет связи · повторить
            </Button>
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
      <nav className="site-tabbar" aria-label="Разделы (нижняя панель)">
        {links.map((link) => {
          const Icon = link.icon;
          return (
            <a
              key={link.id}
              href={hrefOf(link)}
              aria-current={current === link.id ? "page" : undefined}
              data-primary={link.id === "bring" || undefined}
            >
              <Icon aria-hidden="true" />
              <span>{link.label}</span>
            </a>
          );
        })}
      </nav>
    </>
  );
}

/**
 * Notes about the shelf itself (docs/specs/SIGN_IN_PROVIDERS.md § 1, 8, 10):
 * a provisional shelf lives in this browser only and shares nothing until it
 * is claimed; a sign-in by an agent's link names the agent once; a first
 * sign-up in this browser points to «Способы входа» in case a shelf existed.
 */
function ShelfBanners({ account }: { account: Account }) {
  const ways = useSignInWays();
  const [entered] = useState(() => takeEnteredByAgent());
  const [fresh, setFresh] = useState(
    () => !account.provisional && takeFreshShelfNote(),
  );
  const claimed =
    !account.provisional &&
    new URLSearchParams(location.search).get("claimed") === "1";
  return (
    <>
      {account.provisional && (
        <aside className="shelf-banner" aria-label="Временная полка">
          <div>
            <strong>Полка живёт только в этом браузере.</strong> Закрепите
            её — войдите {ways.with}, и ею можно будет делиться ссылками.
            <small>
              Если {account.idleDays ?? 30} дней не открывать полку и не
              пользоваться агентами, она удалится. Потеряли вход? Попросите
              агента: «{OPEN_SHELF_PHRASE}».
            </small>
          </div>
          <a className="ui-button ui-button--primary" href="/claim">
            Закрепить
          </a>
        </aside>
      )}
      {claimed && (
        <aside className="shelf-banner shelf-banner--quiet" role="status">
          <div>
            <strong>Полка закреплена.</strong> Теперь ею можно делиться, а
            входить — выбранным способом.
          </div>
        </aside>
      )}
      {entered && (
        <aside className="shelf-banner shelf-banner--quiet" role="status">
          <div>
            Вы вошли по ссылке от агента <strong>{entered}</strong>.
          </div>
        </aside>
      )}
      {fresh && (
        <aside className="shelf-banner shelf-banner--quiet">
          <div>
            Уже есть полка? Привяжите этот вход к ней в{" "}
            <a href="/settings/agents#sign-in">«Способах входа»</a>.
          </div>
          <Button variant="quiet" onClick={() => setFresh(false)}>
            Понятно
          </Button>
        </aside>
      )}
    </>
  );
}

/**
 * The operator's documents and the source code, linked under every page:
 * AGPL-3.0 § 13 asks that everyone using Полка over the network is offered it.
 */
export function LegalLinks() {
  const sourceUrl = useSourceUrl();
  const onGitHub = new URL(sourceUrl).hostname === "github.com";
  return (
    <footer className="site-footer">
      <nav aria-label="Документы">
        <a href="/privacy">Политика</a>
        <a href="/terms">Соглашение</a>
        <a href="/enterprise">Для компаний</a>
        <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
          {onGitHub ? "Открытый код на GitHub" : "Открытый код"}
        </a>
      </nav>
    </footer>
  );
}

/**
 * Owns the page inset and navigation. Pages only supply local content.
 * `bare` drops the rail, the tab bar and the document links: a guest opening a
 * shared work sees the work, not the app. The wrapper stays the same element,
 * so switching `bare` once the account is known does not remount the page.
 */
export function AppShell({
  current,
  account,
  className = "",
  navigation,
  children,
  actions,
  onLoggedOut,
  bare = false,
  foldableRail = false,
}: {
  current: Section;
  account: Account | null | undefined;
  className?: string;
  navigation?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  onLoggedOut?: () => void;
  bare?: boolean;
  /** The desktop rail starts folded to icons, with a toggle (the owner's work page). */
  foldableRail?: boolean;
}) {
  const [railExpanded, setRailExpanded] = useState(readRailExpanded);
  const folded = foldableRail && !railExpanded;
  return (
    <div
      className={`app-shell${bare ? " app-shell--bare" : ""}${folded ? " app-shell--rail-folded" : ""} ${className}`}
    >
      {!bare && (
        <SiteHeader
          current={current}
          account={account}
          actions={actions}
          onLoggedOut={onLoggedOut}
          collapsed={folded}
          onToggleRail={
            foldableRail
              ? () => {
                  writeRailExpanded(folded);
                  setRailExpanded(folded);
                }
              : undefined
          }
        >
          {navigation}
        </SiteHeader>
      )}
      {!bare && account && <ShelfBanners account={account} />}
      {children}
      {!bare && <LegalLinks />}
    </div>
  );
}
