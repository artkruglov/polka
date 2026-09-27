import React, { useState } from "react";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import {
  agentClients,
  clientSetup,
  type AgentClientId,
  type ClientSetup,
  type SetupCopy,
} from "../../entities/onboarding/agent-setup.ts";
import {
  isLoopbackOrigin,
  reachableFrom,
} from "../../entities/onboarding/connect-phrase.ts";

/** «Где вы работаете с ИИ?»: the five places, one pressed. */
export function ClientCards({
  selected,
  onChoose,
}: {
  selected: AgentClientId | null;
  onChoose: (id: AgentClientId) => void;
}) {
  const reachable = reachableFrom(location.origin);
  return (
    <>
    {isLoopbackOrigin(location.origin) && (
      <p className="agent-setup-intro" role="note">
        Эта Полка работает на вашем компьютере ({location.host}): claude.ai и
        ChatGPT подключаются со своих серверов и до неё не достанут.
        Подключите Claude Code или Codex на этом компьютере, а для скриптов —
        токен в разделе «Для разработчиков».
      </p>
    )}
    <div className="agent-client-cards" role="group" aria-label="Где вы работаете с ИИ">
      {agentClients.filter((item) => reachable(item.id)).map((item) => (
        <button
          key={item.id}
          type="button"
          className="agent-client-card"
          aria-pressed={selected === item.id}
          onClick={() => onChoose(item.id)}
        >
          <strong>{item.name}</strong>
          <small>{item.hint}</small>
        </button>
      ))}
    </div>
    </>
  );
}

export function SetupPanel({
  setup,
  waiting,
}: {
  setup: ClientSetup;
  /** The page is polling: say so, so nobody presses «Обновить» in a loop. */
  waiting: boolean;
}) {
  return (
    <section
      className="agent-setup"
      aria-labelledby="agent-setup-title"
      data-client={setup.id}
    >
      <h3 id="agent-setup-title">{setup.title}</h3>
      <p className="agent-setup-intro">{setup.intro}</p>
      <ol className="agent-setup-steps">
        {setup.steps.map((step, index) => (
          <li key={index}>
            <span className="agent-setup-number" aria-hidden="true">
              {index + 1}
            </span>
            <div className="agent-setup-body">
              <p>{step.text}</p>
              {step.copies?.map((copy) => (
                <CopyBlock key={copy.kind + copy.value} copy={copy} />
              ))}
              {step.note && <p className="agent-setup-note">{step.note}</p>}
            </div>
          </li>
        ))}
      </ol>
      {setup.footnote && <p className="agent-setup-note">{setup.footnote}</p>}
      {waiting && (
        <p className="agent-setup-waiting" role="status">
          Как только агент подключится, здесь появится «Готово».
        </p>
      )}
    </section>
  );
}

export function CopyBlock({ copy }: { copy: SetupCopy }) {
  return (
    <div className="agent-copy" data-kind={copy.kind}>
      {copy.lead && <span className="agent-copy-lead">{copy.lead}</span>}
      <div className="agent-copy-row">
        <code>{copy.value}</code>
        <CopyButton
          value={copy.value}
          label={copy.label}
          successText={copy.copied}
          variant={copy.kind === "command" ? "secondary" : "primary"}
        />
      </div>
    </div>
  );
}


/**
 * The whole instruction for someone not signed in (the landing): pick where
 * you work with AI, get the steps. The same steps as on the agents page.
 */
export function ConnectGuide({ initial = "claude-ai" }: { initial?: AgentClientId }) {
  const [selected, setSelected] = useState<AgentClientId>(() =>
    reachableFrom(location.origin)(initial) ? initial : "claude-code",
  );
  return (
    <>
      <ClientCards selected={selected} onChoose={setSelected} />
      <SetupPanel setup={clientSetup(location.origin, selected)} waiting={false} />
    </>
  );
}
