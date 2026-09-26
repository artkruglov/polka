import "./styles.css";
import React, { useId } from "react";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import { connectPhrase } from "../../entities/onboarding/connect-phrase.ts";
import { SKILL_INDEX_PATH, SKILL_INSTALL } from "../../entities/onboarding/agent-setup.ts";

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
        <CopyButton
          value={phrase}
          label="Скопировать"
          successText="Скопировано"
          variant="primary"
        />
      </div>
      <small>
        Codex и Claude Code выполнят одну команду сами — Полка откроется в
        браузере, токен не нужен. В Claude (claude.ai и Desktop) и ChatGPT
        коннектор добавляют вручную: настройки → коннекторы → адрес{" "}
        <code>{`${location.origin}/mcp`}</code>. Пошагово:{" "}
        <a href="/settings/agents?client=claude-ai">Claude</a> ·{" "}
        <a href="/settings/agents?client=claude-code">Claude Code</a> ·{" "}
        <a href="/settings/agents?client=codex">Codex</a> ·{" "}
        <a href="/settings/agents?client=chatgpt">ChatGPT</a>.
      </small>
      <small className="connect-agent-skill">
        Claude Code и Codex ставят плагин Полки — подключение и скилл
        сразу. Для других агентов скилл отдельно: <code>{SKILL_INSTALL}</code>{" "}
        <CopyButton value={SKILL_INSTALL} variant="quiet" label="Скопировать" successText="Скопировано" />
        <a href={SKILL_INDEX_PATH}>Адрес скилла для агента</a>
      </small>
    </div>
  );
}
