import { UrlImport } from "./index.tsx";
import { useImportCapabilities } from "./useImportCapabilities.ts";
import { Button, TextField } from "../../shared/ui/controls.tsx";
import React, { useState } from "react";
import { FileUp, Link2 } from "lucide-react";
import { classify, type ImportClassification } from "./classify-demo.ts";
import { Status } from "../../shared/ui/Status.tsx";

/**
 * URL demo of /bring. It only recognises the pasted address in the browser: no request, no copy,
 * no receipt and no preview of someone else's page. The single way forward is the real file path.
 */
export function UrlImportCard(props: {
  initialFolderId?: string;
  initial?: string;
  onFile: () => void;
  accountId?: string;
}) {
  const state = useImportCapabilities();
  if (state.status === "failed")
    return (
      <section className="bring-card">
        <p role="alert">
          Не удалось проверить доступность импорта. Обновите страницу или
          сохраните файл.
        </p>
        <Button onClick={props.onFile}>Загрузить файл</Button>
      </section>
    );
  if (state.status === "loading")
    return (
      <section className="bring-card" role="status">
        Проверяем доступность импорта…
      </section>
    );
  return state.capabilities.enabled ? (
    <UrlImport {...props} />
  ) : (
    <UrlImportDemo {...props} />
  );
}

function UrlImportDemo({
  initial = "",
  onFile,
}: {
  initial?: string;
  onFile: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [result, setResult] = useState<ImportClassification | null>(() =>
    initial ? classify(initial) : null,
  );
  return (
    <section
      className="bring-card url-import"
      aria-labelledby="url-import-title"
    >
      <span className="result-kicker">
        <Link2 /> ПО ССЫЛКЕ <Status is="demo" />
      </span>
      <h2 id="url-import-title">Проверить публичную ссылку</h2>
      <p className="bring-hint">
        Импорт по ссылке ещё не подключён: сейчас ссылку распознаём в браузере,
        а копию сохраняем файлом. На сервер ничего не отправляется.
      </p>
      <form
        className="url-import-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) setResult(classify(value));
        }}
      >
        <TextField
          label="Публичная ссылка на работу"
          id="url-import-input"
          inputMode="url"
          placeholder="https://claude.ai/public/artifacts/…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setResult(null);
          }}
        />
        <Button type="submit">Проверить ссылку · демо</Button>
      </form>
      {result && (
        <div
          className="url-import-result"
          role="status"
          data-import-status={result.status}
        >
          <strong>{result.title}</strong>
          {result.host && <small>{result.host}</small>}
          <p>{result.explain}</p>
        </div>
      )}
      <div className="bring-actions">
        <Button variant="primary" onClick={onFile}>
          <FileUp /> Сохранить файлом
        </Button>
      </div>
    </section>
  );
}
