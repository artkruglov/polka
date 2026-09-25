import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Bot, FileUp } from "lucide-react";
import type {
  Account,
  AgentConnection,
} from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import { Button } from "../../shared/ui/controls.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import { TabList, tabId } from "../../shared/ui/Tabs.tsx";
import {
  HERO_CLIENT_IDS,
  SAVE_PHRASE,
  heroClient,
  heroClientNames,
  heroSetup,
  readStoredClient,
  storeClient,
  type HeroClientId,
} from "../../entities/onboarding/agent-setup.ts";
import { readDismissed, writeDismissed } from "../../entities/onboarding/dismissal.ts";

/** While the steps are on screen, how often the hero asks whether an agent has connected. */
export const HERO_POLL_MS = 8000;

const isActive = (c: AgentConnection) => c.status === "issued" || c.status === "seen";

export type Connections =
  | { status: "loading" }
  | { status: "ready"; active: AgentConnection[] }
  | { status: "error" };

/** The owner's agent connections; re-read when the tab comes back (after «Разрешить» in another tab). */
function useAgentConnections(accountId: string, poll: boolean) {
  const [state, setState] = useState<Connections>({ status: "loading" });
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    client.agentConnections
      .list()
      .then((list) => {
        if (current === generation.current)
          setState({ status: "ready", active: list.filter(isActive) });
      })
      .catch(() => {
        // Keep what is shown; a first failure shows the steps, which work either way.
        if (current === generation.current)
          setState((s) => (s.status === "ready" ? s : { status: "error" }));
      });
  }, []);
  useEffect(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      generation.current++;
      document.removeEventListener("visibilitychange", onVisible);
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
  /** The person hid the steps in this browser: one slim line instead. */
  hidden: boolean;
  client: HeroClientId;
  onClient: (id: HeroClientId) => void;
  onHide: () => void;
  onShow: () => void;
  onUpload: () => void;
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
}: AgentHeroProps) {
  const idBase = useId();
  const panelId = `${idBase}-panel`;
  const upload = (
    <button type="button" className="text-button agent-hero-upload" onClick={onUpload}>
      <FileUp aria-hidden="true" /> Загрузить файл
    </button>
  );

  if (connections.status === "loading")
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
          <CopyButton
            value={SAVE_PHRASE}
            label="Скопировать фразу"
            successText="Фраза скопирована"
            variant="quiet"
          />
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

  const setup = heroSetup(origin, selected);
  return (
    <section className="agent-hero" data-state="none" aria-labelledby={`${idBase}-title`}>
      <div className="agent-hero-head">
        <h1 id={`${idBase}-title`}>Подключите агента — он сам сохранит работу на полку</h1>
        <Button variant="quiet" className="agent-hero-hide" onClick={onHide}>
          Скрыть
        </Button>
      </div>
      <TabList
        label="Где вы работаете с ИИ"
        items={HERO_CLIENT_IDS.map((id) => ({ id, label: heroClientNames[id] }))}
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
        <p className="agent-hero-then">{setup.then}</p>
      </div>
      <div className="agent-hero-foot">
        <a className="agent-hero-link" href={`/settings/agents?client=${selected}`}>
          Пошагово и другие клиенты, включая ChatGPT <ArrowUpRight aria-hidden="true" />
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

/** Data and choices: the connections from the API, the remembered client, the per-browser «Скрыть». */
export function AgentHero({
  account,
  onUpload,
}: {
  account: Account;
  onUpload: () => void;
}) {
  const [hidden, setHidden] = useState(() => readDismissed(account.id));
  const [selected, setSelected] = useState<HeroClientId>(() =>
    heroClient(readStoredClient()),
  );
  const [polling, setPolling] = useState(!hidden);
  const connections = useAgentConnections(account.id, polling);
  const connected = connections.status === "ready" && connections.active.length > 0;
  useEffect(() => setPolling(!hidden && !connected), [hidden, connected]);
  return (
    <AgentHeroView
      origin={location.origin}
      connections={connections}
      hidden={hidden}
      client={selected}
      onClient={(id) => {
        setSelected(id);
        storeClient(id);
      }}
      onHide={() => {
        writeDismissed(account.id, true);
        setHidden(true);
      }}
      onShow={() => {
        writeDismissed(account.id, false);
        setHidden(false);
      }}
      onUpload={onUpload}
    />
  );
}
