import "./styles.css";
import React, { useState } from "react";
import { ArrowUpRight, Bot, Layers, LockKeyhole } from "lucide-react";
import { FileSave, SavedWork } from "../../features/capture-file/index.tsx";
import { PasteCode } from "../../features/paste-code/index.tsx";
import { Tabs } from "../../shared/ui/Tabs.tsx";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { UrlImportCard } from "../../features/import-url/card.tsx";
import { Preview } from "../../widgets/artifact-preview/index.ts";
import { scrollBehavior } from "../../shared/lib/motion.ts";

type Capture = "file" | "paste";

/** File capture and capability-gated URL import: one column, the link first, a file or pasted code below. */
export function Bring() {
  const account = useAccount();
  const params = new URLSearchParams(location.search);
  const [initialFolderId] = useState(() => params.get("folder") ?? "");
  const [pasted] = useState(() => params.get("url") ?? "");
  // A recognised Claude/ChatGPT link shows its own file drop; the standalone one steps aside.
  const [providerGuide, setProviderGuide] = useState(false);
  const [capture, setCapture] = useState<Capture>(() =>
    location.hash === "#paste" ? "paste" : "file",
  );
  const toFile = () => {
    setCapture("file");
    requestAnimationFrame(() =>
      document.getElementById("file")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" }),
    );
  };
  const renderPreview = (revision: Parameters<typeof Preview>[0]["revision"], compact: boolean) => (
    <Preview revision={revision} compact={compact} />
  );
  const renderSaved =
    (headingId?: string) =>
    (saved: Pick<Parameters<typeof SavedWork>[0], "receipt" | "work">, restart: () => void) => (
      <SavedWork
        {...saved}
        headingId={headingId}
        renderPreview={renderPreview}
        onRestart={restart}
        restartLabel="Вставить другой код"
      />
    );
  return (
    <AppShell current="bring" account={account} className="bring-page">
      <main className="bring-main" id="main">
        <header className="bring-heading">
          <h1 id="bring-title">Ссылка, которую легко отправить</h1>
          <p>Сохраните артефакт из чата на свою полку</p>
        </header>
        <UrlImportCard
          initial={pasted}
          initialFolderId={initialFolderId}
          onFile={toFile}
          accountId={account?.id}
          onProviderChange={setProviderGuide}
          fileSave={
            <FileSave
              initialFolderId={initialFolderId}
              renderPreview={renderPreview}
              embedded
            />
          }
          pasteCode={
            <PasteCode
              initialFolderId={initialFolderId}
              renderResult={renderSaved()}
              embedded
            />
          }
        />
        <div className="bring-or" hidden={providerGuide} aria-hidden={providerGuide}>
          <span>или</span>
        </div>
        <div className="bring-capture" hidden={providerGuide}>
          <Tabs
            label="Как сохранить"
            value={capture}
            onChange={setCapture}
            items={[
              { id: "file", label: "Загрузить файл" },
              { id: "paste", label: "Вставить код" },
            ]}
          >
            {capture === "file" ? (
              <FileSave
                initialFolderId={initialFolderId}
                renderPreview={renderPreview}
                titled={false}
              />
            ) : (
              <PasteCode
                initialFolderId={initialFolderId}
                renderResult={renderSaved("paste-code-title")}
                titled={false}
              />
            )}
          </Tabs>
        </div>
        <aside className="bring-facts" aria-label="О сохранении">
          <div className="bring-fact">
            <LockKeyhole />
            <div>
              <strong>Сначала — только для вас</strong>
              <p>Доступ по ссылке вы включаете отдельно.</p>
            </div>
          </div>
          <div className="bring-fact">
            <Layers />
            <div>
              <strong>Версии остаются</strong>
              <p>Новая версия не ломает отправленную ссылку.</p>
            </div>
          </div>
          <a className="bring-fact bring-fact--link" href="/settings/agents">
            <Bot />
            <div>
              <strong>Сохраняйте прямо с агентом</strong>
              <p>
                Claude Code, Codex, MCP-клиент или свой скрипт через HTTP API{" "}
                <ArrowUpRight />
              </p>
            </div>
          </a>
        </aside>
      </main>
    </AppShell>
  );
}
