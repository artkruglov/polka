import React, { useEffect, useRef, useState } from "react";
import { ExternalLink, Puzzle } from "lucide-react";
import type { ImportStage } from "../../../../../packages/contracts/extension-bridge.ts";
import { Button, LinkButton } from "../../shared/ui/controls.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import {
  findExtension,
  type ExtensionLink,
  type ImportResult,
} from "./extension-bridge.ts";

/** Where people read how to install the extension (store listing pending). */
export const EXTENSION_GUIDE_URL =
  "https://github.com/artkruglov/polka/blob/main/extensions/chrome/README.md";

const stages: Record<ImportStage, string> = {
  connecting: "Подключаем расширение к Полке — разрешите доступ в открывшемся окне",
  opening: "Открываем артефакт в фоновой вкладке вашего браузера",
  extracting: "Забираем код артефакта",
  saving: "Сохраняем на полку",
};

type State =
  | { kind: "detecting" }
  | { kind: "absent" }
  | { kind: "ready" }
  | { kind: "running"; stage: ImportStage | null }
  | { kind: "done"; result: ImportResult };

/**
 * A Claude/ChatGPT link cannot be fetched by the server, but the user's own
 * browser can open it. With the «На Полку» extension installed the page hands
 * the link over (extension-bridge.ts); without it, it says how to get one.
 */
export function ExtensionSave({
  url,
  autoStart,
}: {
  url: string;
  /** The user has just pressed «Сохранить»: start without a second click. */
  autoStart: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "detecting" });
  const link = useRef<ExtensionLink | null>(null);
  const started = useRef(false);

  const run = async () => {
    if (!link.current || started.current) return;
    started.current = true;
    setState({ kind: "running", stage: null });
    const result = await link.current.importArtifact(url, (stage) =>
      setState({ kind: "running", stage }),
    );
    started.current = false;
    setState({ kind: "done", result });
  };

  useEffect(() => {
    let alive = true;
    void findExtension().then((found) => {
      if (!alive) {
        found?.close();
        return;
      }
      link.current = found;
      setState(found ? { kind: "ready" } : { kind: "absent" });
      if (found && autoStart) void run();
    });
    return () => {
      alive = false;
      link.current?.close();
      link.current = null;
    };
    // The link is found once per pasted URL; autoStart only matters then.
  }, [url]);

  if (state.kind === "detecting" || state.kind === "absent")
    return (
      <div className="url-import-action" data-extension={state.kind}>
        <Puzzle aria-hidden="true" />
        <div>
          <strong>Расширение «На Полку»</strong>
          <p>
            Откроет ссылку в вашем браузере, где вы уже вошли в{" "}
            {providerName(url)}, и сохранит работу само — без скачивания.
          </p>
        </div>
        {state.kind === "absent" ? (
          <LinkButton href={EXTENSION_GUIDE_URL} target="_blank" rel="noopener">
            Установить расширение
          </LinkButton>
        ) : (
          <Button disabled>Ищем расширение…</Button>
        )}
      </div>
    );
  if (state.kind === "ready")
    return (
      <div className="url-import-action" data-extension="ready">
        <Puzzle aria-hidden="true" />
        <div>
          <strong>Расширение «На Полку» установлено</strong>
          <p>
            Оно откроет ссылку в фоновой вкладке вашего браузера и сохранит
            работу на полку, к которой подключено.
          </p>
        </div>
        <Button variant="primary" onClick={() => void run()}>
          Сохранить расширением
        </Button>
      </div>
    );
  if (state.kind === "running")
    return (
      <div className="url-import-status" role="status" aria-live="polite">
        <h3>{state.stage ? stages[state.stage] : "Передаём ссылку расширению"}…</h3>
        <p>Не закрывайте эту вкладку. Обычно это занимает до полуминуты.</p>
      </div>
    );
  const { result } = state;
  if (!result.ok)
    return (
      <div className="url-import-status" role="alert">
        <h3>Расширение не смогло сохранить артефакт</h3>
        <p>{result.message}</p>
        <Button onClick={() => void run()}>Повторить</Button>
      </div>
    );
  return (
    <div className="url-import-status" role="status" aria-live="polite">
      <h3>«{result.title}» на полке</h3>
      {result.url && (
        <input
          className="url-import-link"
          readOnly
          value={result.url}
          aria-label="Ссылка на работу"
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      {result.note && <p>{result.note}</p>}
      <div className="bring-actions">
        {result.url && <CopyButton value={result.url} label="Копировать" variant="primary" />}
        <LinkButton href={result.shelfUrl}>
          <ExternalLink /> Открыть на полке
        </LinkButton>
      </div>
    </div>
  );
}

function providerName(url: string) {
  try {
    return new URL(url).hostname.endsWith("chatgpt.com") ? "ChatGPT" : "Claude";
  } catch {
    return "Claude";
  }
}
