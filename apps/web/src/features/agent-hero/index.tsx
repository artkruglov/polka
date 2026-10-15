import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Bot, FileUp } from "lucide-react";
import type { Account, AgentConnection } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import { Button } from "../../shared/ui/controls.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import { TabList, tabId } from "../../shared/ui/Tabs.tsx";
import {
  CONNECT_AGENT_TITLE,
  HERO_CLIENT_IDS,
  SAVE_PHRASE,
  heroClient,
  heroClientNames,
  heroSetup,
  readStoredClient,
  storeClient,
  type HeroClientId,
} from "../../entities/onboarding/agent-setup.ts";
import { reachableFrom } from "../../entities/onboarding/connect-phrase.ts";
import {
  readAgentSeen,
  recordDismissal,
  resolveDismissed,
  writeAgentSeen,
  writeDismissed,
} from "../../entities/onboarding/dismissal.ts";
import { onAgentConnected } from "../../entities/onboarding/agent-connected.ts";
import { heroOffered } from "../../entities/onboarding/hero.ts";

/** While the steps are on screen, how often the hero asks whether an agent has connected. */
export const HERO_POLL_MS = 8000;
/** After «Разрешить» in another tab: asks again this long after the signal. */
const AGENT_CONNECTED_RETRIES_MS = [2000, 5000];

const isActive = (c: AgentConnection) => c.status === "issued" || c.status === "seen";

export type Connections = { status: "loading" } | { status: "ready"; active: AgentConnection[] } | { status: "error" };

/** The owner's agent connections; re-read when the tab comes back (after «Разрешить» in another tab). */
function useAgentConnections(accountId: string, hidden: boolean) {
  const [state, setState] = useState<Connections>({ status: "loading" });
  // Polls while the steps are shown and no agent is connected yet.
  const poll = !hidden && !(state.status === "ready" && state.active.length > 0);
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    client.agentConnections
      .list()
      .then((list) => {
        if (current === generation.current) setState({ status: "ready", active: list.filter(isActive) });
      })
      .catch(() => {
        // Keep what is shown; a first failure shows the steps, which work either way.
        if (current === generation.current) setState((s) => (s.status === "ready" ? s : { status: "error" }));
      });
  }, []);
  useEffect(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    // «Разрешить» in another tab (/oauth/consent): the agent exchanges its
    // code a moment later, so ask now and twice more; the poll stays.
    const timers: ReturnType<typeof setTimeout>[] = [];
    const stop = onAgentConnected(() => {
      load();
      for (const ms of AGENT_CONNECTED_RETRIES_MS) timers.push(setTimeout(load, ms));
    });
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- a counter, not a DOM ref: bumping the latest value drops late answers
      generation.current++;
      document.removeEventListener("visibilitychange", onVisible);
      stop();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [accountId, load]);
  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, HERO_POLL_MS);
    return () => clearInterval(timer);
  }, [poll, load]);
  return state;
}

export type AgentHeroProps = {
  origin: string;
  connections: Connections;
  /** Hidden by the owner, or not offered to this shelf (heroOffered): one slim line instead. */
  hidden: boolean;
  client: HeroClientId;
  onClient: (id: HeroClientId) => void;
  onHide: () => void;
  onShow: () => void;
  onUpload: () => void;
  /** This browser last saw an agent connected (readAgentSeen). */
  expectConnected?: boolean;
};

/**
 * The top of the home shelf. Without a connected agent: one compact block —
 * «Подключите агента», a switcher of four clients and the one step each
 * needs, with /settings/agents as the full version. With an agent (or once
 * hidden): a single slim line, so the shelf gets the space.
 */
export function AgentHeroView({
  origin,
  connections,
  hidden,
  client: selected,
  onClient,
  onHide,
  onShow,
  onUpload,
  expectConnected = false,
}: AgentHeroProps) {
  const idBase = useId();
  const panelId = `${idBase}-panel`;
  const upload = (
    <button type="button" className="text-button agent-hero-upload" onClick={onUpload}>
      <FileUp aria-hidden="true" /> Загрузить файл
    </button>
  );

  // While the check runs, the hero keeps the shape this browser saw last
  // (M8: no layout shift): one line when an agent was connected or the steps
  // are hidden, the steps otherwise.
  if (connections.status === "loading" && (expectConnected || hidden))
    return (
      <section className="agent-hero agent-hero--slim" aria-busy="true" aria-label="Агент">
        <h1 className="sr-only">Полка</h1>
        <p className="agent-hero-line" role="status">
          Проверяем подключения…
        </p>
      </section>
    );

  if (connections.status === "ready" && connections.active.length) {
    const [first, ...rest] = connections.active;
    const names = rest.length ? `${first.name} и ещё ${rest.length}` : first.name;
    return (
      <section className="agent-hero agent-hero--slim" data-state="connected" aria-label="Агент">
        <h1 className="sr-only">Полка</h1>
        <p className="agent-hero-line">
          <span className="agent-hero-dot" aria-hidden="true" />
          <span>
            <strong>Подключено: {names}.</strong> Попросите агента: «{SAVE_PHRASE}»
          </span>
        </p>
        <div className="agent-hero-actions">
          <CopyButton value={SAVE_PHRASE} label="Скопировать фразу" successText="Фраза скопирована" variant="quiet" />
          <a className="agent-hero-link" href="/settings/agents">
            <Bot aria-hidden="true" /> Агенты
          </a>
          {upload}
        </div>
      </section>
    );
  }

  if (hidden)
    return (
      <section className="agent-hero agent-hero--slim" data-state="hidden" aria-label="Агент">
        <h1 className="sr-only">Полка</h1>
        <p className="agent-hero-line">
          <Bot aria-hidden="true" />
          <span>Агент сам сохранит работу на полку, когда вы попросите.</span>
        </p>
        <div className="agent-hero-actions">
          <button type="button" className="text-button" onClick={onShow}>
            Подключить агента
          </button>
          {upload}
        </div>
      </section>
    );

  // claude.ai cannot reach an installation on this computer (127.0.0.1).
  const tabs = HERO_CLIENT_IDS.filter(reachableFrom(origin));
  if (!tabs.includes(selected)) selected = tabs[0]!;
  const setup = heroSetup(origin, selected);
  return (
    <section className="agent-hero" data-state="none" aria-labelledby={`${idBase}-title`}>
      <div className="agent-hero-head">
        <h1 id={`${idBase}-title`}>{CONNECT_AGENT_TITLE}</h1>
        <Button variant="quiet" className="agent-hero-hide" onClick={onHide}>
          Скрыть
        </Button>
      </div>
      <TabList
        label="Где вы работаете с ИИ"
        items={tabs.map((id) => ({ id, label: heroClientNames[id] }))}
        value={selected}
        onChange={onClient}
        idBase={idBase}
        panelId={panelId}
        className="agent-hero-tabs"
      />
      <div
        className="agent-hero-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(idBase, selected)}
        data-client={selected}
      >
        <p className="agent-hero-lead">{setup.lead}</p>
        {setup.copies.map((copy) => (
          <div key={copy.value} className="agent-hero-copy" data-kind={copy.kind}>
            {copy.lead && <span className="agent-hero-copy-lead">{copy.lead}</span>}
            <div className="agent-hero-copy-row">
              <code>{copy.value}</code>
              <CopyButton
                value={copy.value}
                label={copy.label}
                successText={copy.copied}
                variant={copy === setup.copies[0] ? "primary" : "secondary"}
              />
            </div>
          </div>
        ))}
        <p className="agent-hero-then">{setup.next}</p>
      </div>
      <div className="agent-hero-foot">
        <a className="agent-hero-link" href={`/settings/agents?client=${selected}`}>
          {tabs.includes("claude-ai") ? "Пошагово и другие клиенты, включая ChatGPT" : "Пошагово и токены для скриптов"}{" "}
          <ArrowUpRight aria-hidden="true" />
        </a>
        <span className="agent-hero-or">
          или {upload}
          <span className="agent-hero-fine">HTML, текст или изображение до 5 МБ</span>
        </span>
      </div>
      {connections.status === "error" && (
        <p className="agent-hero-then" role="status">
          Не удалось проверить подключения — шаги выше работают в любом случае.
        </p>
      )}
    </section>
  );
}

/**
 * Data and choices: the connections from the API, the remembered client,
 * «Скрыть» on the account (resolveDismissed), and who is offered the steps at
 * all (heroOffered: young shelves or few works).
 */
export function AgentHero({
  account,
  works,
  onUpload,
}: {
  account: Account;
  /** Works on the whole shelf (no search or filter); null while unknown. */
  works: number | null;
  onUpload: () => void;
}) {
  const [initial] = useState(() => resolveDismissed(account.id, account.onboardingHiddenAt));
  const [dismissed, setDismissed] = useState(initial.hidden);
  // «Подключить агента» from the slim line: the steps, whatever the shelf's age.
  const [asked, setAsked] = useState(false);
  // Decided once per visit: a search or a filter does not move the shelf.
  const offeredNow = heroOffered({ createdAt: account.createdAt, works });
  const [offered, setOffered] = useState(offeredNow);
  if (offered === null && offeredNow !== null) setOffered(offeredNow);
  const hidden = !asked && (dismissed || offered !== true);
  const remember = (onboardingHiddenAt: string | null) => recordDismissal(account.id, onboardingHiddenAt);
  // A «Скрыть» this browser kept before the server knew (before migration
  // 077, or a failed request) goes to the account once.
  useEffect(() => {
    if (initial.migrate)
      client.onboarding
        .hide()
        .then((r) => remember(r.onboardingHiddenAt))
        .catch(() => {});
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);
  const [selected, setSelected] = useState<HeroClientId>(() => heroClient(readStoredClient()));
  const connections = useAgentConnections(account.id, hidden);
  const connected = connections.status === "ready" && connections.active.length > 0;
  const [expectConnected] = useState(() => readAgentSeen(account.id));
  useEffect(() => {
    if (connections.status === "ready") writeAgentSeen(account.id, connected);
  }, [account.id, connections.status, connected]);
  return (
    <AgentHeroView
      expectConnected={expectConnected}
      origin={location.origin}
      connections={connections}
      hidden={hidden}
      client={selected}
      onClient={(id) => {
        setSelected(id);
        storeClient(id);
      }}
      onHide={() => {
        // At once in this browser; the account follows (a failure stays
        // here as unsynced and is sent on the next visit).
        writeDismissed(account.id, true);
        setDismissed(true);
        setAsked(false);
        client.onboarding
          .hide()
          .then((r) => remember(r.onboardingHiddenAt))
          .catch(() => {});
      }}
      onShow={() => {
        setAsked(true);
        if (!dismissed) return;
        writeDismissed(account.id, false);
        setDismissed(false);
        client.onboarding
          .unhide()
          .then(() => remember(null))
          .catch(() => {});
      }}
      onUpload={onUpload}
    />
  );
}
