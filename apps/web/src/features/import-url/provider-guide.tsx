import React, { useState } from "react";
import { Bot, ClipboardPaste, FileUp, Puzzle } from "lucide-react";
import { Button } from "../../shared/ui/controls.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import { ServiceMark } from "../../shared/ui/ServiceMark.tsx";
import type { ImportClassification } from "./classify-link.ts";
import { importableArtifact } from "../../../../../packages/contracts/extension-bridge.ts";
import { ExtensionSave } from "./extension-save.tsx";

/** What the user copies to their agent; the agent asks them for the artifact's code. */
export const agentPhrase = (url: string) => `Сохрани на Полку артефакт по ссылке ${url}`;

/**
 * A link of a service whose terms forbid automated extraction (Claude,
 * ChatGPT, v0, Perplexity, AI Studio): Полка's server never opens it. The card
 * offers the ways that work from the user's side: the «На Полку» extension in
 * their own browser, their agent over MCP, a downloaded file, or (composed by
 * the page) keeping the link itself as a bookmark.
 */
export function ProviderGuide({
  result,
  url,
  autoStart = false,
  fileSave,
  pasteCode,
  saveLink,
  onFile,
}: {
  result: ImportClassification;
  /** The pasted link: the «На Полку» extension can open it in this browser. */
  url?: string;
  autoStart?: boolean;
  fileSave?: React.ReactNode;
  pasteCode?: React.ReactNode;
  /** «Сохранить как ссылку», composed by the page. */
  saveLink?: React.ReactNode;
  onFile: () => void;
}) {
  const app = result.provider?.name ?? "сервисе";
  const artifact = url ? importableArtifact(url) : null;
  const [file, setFile] = useState(false);
  return (
    <div className="url-import-provider" data-import-status={result.status}>
      <div className="url-import-provider-head" role="status">
        <ServiceMark provider={result.provider} />
        <div>
          <strong>{result.title}</strong>
          {result.host && <small>{result.host}</small>}
        </div>
      </div>
      <p className="url-import-provider-explain">{result.explain}</p>
      <div className="url-import-actions">
        {artifact ? (
          <ExtensionSave url={artifact.url} autoStart={autoStart} />
        ) : (
          <div className="url-import-action" data-extension="unsupported">
            <Puzzle aria-hidden="true" />
            <div>
              <strong>Расширение «На Полку»</strong>
              <p>Пока сохраняет артефакты Claude и ChatGPT; для {app} используйте агента или файл.</p>
            </div>
          </div>
        )}
        {url && (
          <div className="url-import-action" data-action="agent">
            <Bot aria-hidden="true" />
            <div>
              <strong>Попросить агента</strong>
              <p>
                Отправьте эту фразу агенту с подключённой Полкой — он попросит
                вставить код артефакта и сохранит его.{" "}
                <a href="/settings/agents">Подключить агента</a>
              </p>
              <code className="url-import-phrase">{agentPhrase(url)}</code>
            </div>
            <CopyButton value={agentPhrase(url)} label="Скопировать фразу" />
          </div>
        )}
        <div className="url-import-action" data-action="file">
          <FileUp aria-hidden="true" />
          <div>
            <strong>Загрузить файл</strong>
            <p>
              В {app} откройте артефакт, в меню ⋯ выберите Download и загрузите
              скачанный файл сюда.
            </p>
          </div>
          <Button onClick={() => (fileSave ? setFile((open) => !open) : onFile())} aria-expanded={fileSave ? file : undefined}>
            Загрузить файл
          </Button>
        </div>
        {file && fileSave && <div className="url-import-file">{fileSave}</div>}
        {saveLink}
      </div>
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
