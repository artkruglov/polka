import "./styles.css";
import React, { useId } from "react";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import { connectPhrase, isLoopbackOrigin } from "../../entities/onboarding/connect-phrase.ts";
import {
  CLAUDE_PLUGIN_INSTALL,
  CODEX_LOGIN,
  CODEX_PLUGIN_INSTALL,
  SKILL_INDEX_PATH,
  SKILL_INSTALL,
} from "../../entities/onboarding/agent-setup.ts";

/** A command to run by hand, with its copy button and what comes after. */
function Command({ label, command, after }: { label: string; command: string; after?: React.ReactNode }) {
  return (
    <li>
      <strong>{label}</strong>
      <span className="connect-agent-command">
        <code>{command}</code>
        <CopyButton value={command} variant="quiet" label="Скопировать" successText="Скопировано" />
      </span>
      {after && <small>{after}</small>}
    </li>
  );
}

/**
 * The phrase an agent needs to connect Полка, with the manual way for
 * connectors: the first thing on the landing and on «Сохранить».
 */
export function ConnectAgent({
  title = "Скопируйте своему агенту",
  className = "",
}: {
  title?: string;
  className?: string;
}) {
  const titleId = useId();
  const phrase = connectPhrase(location.origin);
  return (
    <div className={`connect-agent ${className}`} role="group" aria-labelledby={titleId}>
      <span id={titleId} className="connect-agent-title">
        {title}
      </span>
      <div className="connect-agent-phrase">
        <code>{phrase}</code>
        <CopyButton value={phrase} label="Скопировать" successText="Скопировано" variant="primary" />
      </div>
      {isLoopbackOrigin(location.origin) ? (
        // claude.ai and ChatGPT connect from their servers: not to 127.0.0.1.
        <small>
          Codex и Claude Code на этом компьютере выполнят одну команду сами — Полка откроется в браузере. Эта Полка
          работает локально, поэтому claude.ai и ChatGPT до неё не достанут; скриптам нужен{" "}
          <a href="/settings/agents?client=other">токен</a>. Пошагово:{" "}
          <a href="/settings/agents?client=claude-code">Claude Code</a> ·{" "}
          <a href="/settings/agents?client=codex">Codex</a>.
        </small>
      ) : (
        <small>
          Codex и Claude Code выполнят одну команду сами — Полка откроется в браузере, токен не нужен. В Claude
          (claude.ai и Desktop) и ChatGPT коннектор добавляют вручную: настройки → коннекторы → адрес{" "}
          <code>{`${location.origin}/mcp`}</code>. Пошагово: <a href="/settings/agents?client=claude-ai">Claude</a> ·{" "}
          <a href="/settings/agents?client=claude-code">Claude Code</a> ·{" "}
          <a href="/settings/agents?client=codex">Codex</a> · <a href="/settings/agents?client=chatgpt">ChatGPT</a>.
        </small>
      )}
      <details className="connect-agent-manual">
        <summary>Команды для терминала</summary>
        <ol>
          <Command
            label="Claude Code"
            command={CLAUDE_PLUGIN_INSTALL}
            after={
              <>
                Плагин ставит подключение и скиллы. Затем в Claude Code: <code>/mcp</code> →{" "}
                <code>plugin:polka:polka</code> → Authenticate.
              </>
            }
          />
          <Command
            label="Codex"
            command={CODEX_PLUGIN_INSTALL}
            after={
              <>
                Затем <code>{CODEX_LOGIN}</code> — вход откроется в браузере.
              </>
            }
          />
          <Command
            label="Если плагин не ставится"
            command={`claude mcp add --transport http --scope user polka ${location.origin}/mcp`}
            after={
              <>
                Для Codex: <code>{`codex mcp add polka --url ${location.origin}/mcp`}</code>. GitHub не нужен,
                подключение то же.
              </>
            }
          />
          <Command
            label="Только скилл, для других агентов"
            command={SKILL_INSTALL}
            after={<a href={SKILL_INDEX_PATH}>Адрес скилла для агента</a>}
          />
        </ol>
      </details>
    </div>
  );
}
