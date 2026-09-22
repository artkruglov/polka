import React from "react";
import { ClipboardPaste, FileUp } from "lucide-react";
import { Button } from "../../shared/ui/controls.tsx";
import type { ImportClassification } from "./classify-demo.ts";

/**
 * Claude/ChatGPT artifacts cannot be fetched by Полка, so the pasted link turns
 * into the shortest real path: download in the chat, drop the file right here,
 * or copy the artifact's code and paste it (both composed by the page).
 */
export function ProviderGuide({
  result,
  fileSave,
  pasteCode,
  onFile,
}: {
  result: ImportClassification;
  fileSave?: React.ReactNode;
  pasteCode?: React.ReactNode;
  onFile: () => void;
}) {
  const app = result.source === "chatgpt" ? "ChatGPT" : "Claude";
  return (
    <>
      <div
        className="url-import-result"
        role="status"
        data-import-status={result.status}
      >
        <strong>{result.title}</strong>
        {result.host && <small>{result.host}</small>}
        <p>{result.explain}</p>
        <ol className="url-import-steps">
          <li>Откройте работу в {app}.</li>
          <li>В меню ⋯ выберите Download и сохраните файл.</li>
          <li>Перетащите файл ниже — Полка сохранит копию и даст ссылку.</li>
        </ol>
      </div>
      {fileSave ? (
        <div className="url-import-file">{fileSave}</div>
      ) : (
        <div className="bring-actions">
          <Button variant="primary" onClick={onFile}>
            <FileUp /> Загрузить скачанный файл
          </Button>
        </div>
      )}
      {pasteCode && (
        <details className="url-import-paste">
          <summary>
            <ClipboardPaste /> Или скопируйте код артефакта в {app} и вставьте
            сюда
          </summary>
          <p>
            В {app} откройте работу и нажмите «Копировать» (Copy) — скопируется
            её код. Скачивать файл не нужно.
          </p>
          {pasteCode}
        </details>
      )}
      <p className="url-import-agent">
        Агент может сохранить работу сам:{" "}
        <a href="/settings/agents">подключите Claude Code или Codex</a>.
      </p>
    </>
  );
}
