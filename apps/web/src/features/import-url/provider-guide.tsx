import React from "react";
import { Bot, ClipboardPaste, FileDown, FileUp } from "lucide-react";
import { Button } from "../../shared/ui/controls.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import { ServiceMark } from "../../shared/ui/ServiceMark.tsx";
import type { ImportClassification } from "./classify-link.ts";
import { importableArtifact } from "../../../../../packages/contracts/extension-bridge.ts";
import { ExtensionSave } from "./extension-save.tsx";
import { SaveLinkAction } from "./save-link.tsx";

/** What the user copies to their agent: it asks them for the artifact's code. */
export const agentPhrase = (url: string) => `Сохрани на Полку артефакт по ссылке ${url}`;
/** Said in the Claude chat where the artifact is, with the Полка connector on: Claude sends the source itself. */
export const CLAUDE_PHRASE = "Сохрани этот артефакт на Полку";

/** Why the card is shown, in the words of the import that did not work. */
const BLOCKED: Record<string, string> = {
  source_blocked: "показал серверу Полки проверку на бота. Полка такие проверки не обходит и попытку не повторяет.",
  robots_disallowed: "запрещает роботам открывать эту страницу (robots.txt), и Полка это соблюдает.",
  robots_unavailable: "не отдал robots.txt, поэтому Полка страницу не открыла.",
  timeout: "не ответил вовремя.",
  source_unavailable: "не отдал страницу: возможно, ссылка закрыта или удалена.",
};

/**
 * A link whose content Полка's server could not or may not take (Claude,
 * v0, Perplexity, AI Studio; ChatGPT or Claude when the server's attempt was
 * refused). The ways that always work, simplest first: the user's own agent,
 * the link itself as a work, a downloaded file dropped right here. The
 * extension and the bookmarklet (/bookmarklet) wait behind «Сохранять в один клик».
 */
export function ProviderGuide({
  result,
  url,
  autoStart = false,
  fileSave,
  pasteCode,
  onFile,
  folderId,
  failure,
}: {
  result: ImportClassification;
  /** The pasted link: the phrase, the link work and the extension use it. */
  url?: string;
  /** Start the extension without a second click (only once it is opened). */
  autoStart?: boolean;
  fileSave?: React.ReactNode;
  pasteCode?: React.ReactNode;
  onFile: () => void;
  folderId?: string;
  /** The server tried and this is its error code (source_blocked…). */
  failure?: string | null;
}) {
  const app = result.provider?.name ?? "сервисе";
  const claude = result.provider?.id === "claude";
  const artifact = url ? importableArtifact(url) : null;
  const explain = failure
    ? `${result.provider?.name ?? "Сайт"} ${BLOCKED[failure] ?? "не отдал страницу серверу Полки."} Сохраните работу одним из способов ниже.`
    : result.explain;
  return (
    <div className="url-import-provider" data-import-status={result.status} data-failure={failure ?? undefined}>
      <div className="url-import-provider-head" role="status">
        <ServiceMark provider={result.provider} />
        <div>
          <strong>{result.title}</strong>
          {result.host && <small>{result.host}</small>}
        </div>
      </div>
      <p className="url-import-provider-explain">{explain}</p>
      <div className="url-import-actions">
        {url && (
          <div className="url-import-action" data-action="agent">
            <Bot aria-hidden="true" />
            <div>
              <strong>{claude ? "Попросить Claude" : "Попросить агента"}</strong>
              <p>
                {claude
                  ? "Напишите это в чате Claude, где открыт артефакт: Claude с подключённой Полкой отправит код сам. "
                  : "Отправьте эту фразу агенту с подключённой Полкой: он попросит код артефакта и сохранит его. "}
                <a href="/settings/agents">{claude ? "Подключить Полку к Claude" : "Подключить агента"}</a>
              </p>
              <code className="url-import-phrase">{claude ? CLAUDE_PHRASE : agentPhrase(url)}</code>
            </div>
            <CopyButton value={claude ? CLAUDE_PHRASE : agentPhrase(url)} label="Скопировать фразу" />
          </div>
        )}
        {url && <SaveLinkAction url={url} folderId={folderId} />}
        <div className="url-import-drop" data-action="file">
          <div className="url-import-drop-head">
            <FileDown aria-hidden="true" />
            <strong>Скачайте в {app} (Export → Download) и перетащите сюда</strong>
          </div>
          {fileSave ?? (
            <Button onClick={onFile}>
              <FileUp /> Выбрать файл
            </Button>
          )}
        </div>
      </div>
      <details className="url-import-oneclick">
        <summary>Сохранять в один клик</summary>
        {artifact ? (
          <ExtensionSave url={artifact.url} autoStart={autoStart} />
        ) : (
          <p>Расширение «На Полку» пока сохраняет артефакты Claude и ChatGPT.</p>
        )}
        <p data-slot="bookmarklet">
          Без расширения: <a href="/bookmarklet">закладка «На Полку»</a> в панели
          закладок читает артефакт в вашем браузере и передаёт его Полке.
        </p>
      </details>
      {pasteCode && (
        <details className="url-import-paste">
          <summary>
            <ClipboardPaste /> Или скопируйте код артефакта в {app} и вставьте
            сюда
          </summary>
          <p>
            В {app} откройте артефакт и нажмите «Копировать» (Copy) — скопируется
            его код. Скачивать файл не нужно.
          </p>
          {pasteCode}
        </details>
      )}
    </div>
  );
}
