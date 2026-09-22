import React from "react";
import { FileUp } from "lucide-react";
import { Button } from "../../shared/ui/controls.tsx";
import type { ImportClassification } from "./classify-demo.ts";

/**
 * Claude/ChatGPT artifacts cannot be fetched by Полка, so the pasted link turns
 * into the shortest real path: download in the chat, drop the file right here.
 */
export function ProviderGuide({
  result,
  fileSave,
  onFile,
}: {
  result: ImportClassification;
  fileSave?: React.ReactNode;
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
      <p className="bring-hint">
        Агент может сохранить работу сам:{" "}
        <a href="/settings/agents">подключите Claude Code или Codex</a>. Скоро —
        кнопка «На Полку» прямо в чате Claude.
      </p>
    </>
  );
}
