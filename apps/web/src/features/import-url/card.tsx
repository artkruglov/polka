import { UrlImport } from "./index.tsx";
import { useCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import { Button, IconButton } from "../../shared/ui/controls.tsx";
import React, { useEffect, useState } from "react";
import { FileUp, Link2, X } from "lucide-react";
import { classify, type ImportClassification } from "./classify-link.ts";
import { ProviderGuide } from "./provider-guide.tsx";

/**
 * The link field of /bring. With server import enabled it saves public pages;
 * otherwise the address is only recognised in the browser (no request, no copy)
 * and the way forward is the file or pasted code.
 */
export function UrlImportCard(props: {
  initialFolderId?: string;
  initial?: string;
  onFile: () => void;
  accountId?: string;
  /** File capture rendered inside the card for provider links (composed by the page). */
  fileSave?: React.ReactNode;
  /** Paste capture offered next to it (composed by the page). */
  pasteCode?: React.ReactNode;
  onProviderChange?: (active: boolean) => void;
}) {
  const state = useCapabilities();
  if (state.status === "failed")
    return (
      <section className="url-import">
        <p className="ui-field-error" role="alert">
          Не удалось проверить доступность импорта. Обновите страницу или
          сохраните файл.
        </p>
        <Button onClick={props.onFile}>Загрузить файл</Button>
      </section>
    );
  if (state.status === "loading")
    return (
      <section className="url-import url-import-hint" role="status">
        Проверяем доступность импорта…
      </section>
    );
  return state.capabilities.urlImport ? (
    <UrlImport {...props} sources={state.capabilities.urlImportSources} />
  ) : (
    <UrlRecognizer {...props} />
  );
}

function UrlRecognizer({
  initial = "",
  onFile,
  fileSave,
  pasteCode,
  onProviderChange,
}: {
  initial?: string;
  onFile: () => void;
  fileSave?: React.ReactNode;
  pasteCode?: React.ReactNode;
  onProviderChange?: (active: boolean) => void;
}) {
  const [value, setValue] = useState(initial);
  const [result, setResult] = useState<ImportClassification | null>(() =>
    initial ? classify(initial) : null,
  );
  const provider = result?.status === "provider";
  useEffect(() => {
    onProviderChange?.(provider);
  }, [provider, onProviderChange]);
  return (
    <section className="url-import" aria-labelledby="url-import-title">
      <h2 id="url-import-title" className="sr-only">Сохранить работу по ссылке</h2>
      <p className="url-import-hint">
        Вставьте ссылку на артефакт — подскажем самый быстрый способ перенести
        его на вашу полку. Ссылка проверяется в браузере и никуда не отправляется.
      </p>
      <form
        className="url-import-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) setResult(classify(value));
        }}
      >
        <label className="bring-field">
          <Link2 aria-hidden="true" />
          <input
            id="url-import-input"
            inputMode="url"
            aria-label="Ссылка на работу"
            placeholder="https://claude.ai/artifact/…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {value && (
            <IconButton size="sm" label="Очистить" onClick={() => { setValue(""); setResult(null); }}>
              <X />
            </IconButton>
          )}
        </label>
        <Button type="submit" variant="primary">Продолжить</Button>
      </form>
      {result && provider ? (
        <ProviderGuide
          result={result}
          url={value.trim()}
          fileSave={fileSave}
          pasteCode={pasteCode}
          onFile={onFile}
        />
      ) : (
        <>
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
          {result && (
            <div className="bring-actions">
              <Button variant="quiet" onClick={onFile}>
                <FileUp /> Сохранить файлом
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
