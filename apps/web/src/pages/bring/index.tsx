import "./styles.css";
import React, { useState } from "react";
import { ArrowUpRight, Bot, Layers, LockKeyhole } from "lucide-react";
import { FileSave, SavedWork } from "../../features/capture-file/index.tsx";
import { PasteCode } from "../../features/paste-code/index.tsx";
import { Tabs } from "../../shared/ui/Tabs.tsx";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { Preview } from "../../widgets/artifact-preview/index.ts";

type Capture = "file" | "paste";

/**
 * Save by hand: a file from the computer or pasted code, one column. Saving
 * by a link to a Claude/ChatGPT artifact is not offered: the agent saves the
 * work itself (docs/connect-agents.md), and ?url= from old links is ignored.
 */
export function Bring() {
  const account = useAccount();
  const params = new URLSearchParams(location.search);
  const [initialFolderId] = useState(() => params.get("folder") ?? "");
  const [capture, setCapture] = useState<Capture>(() =>
    location.hash === "#paste" ? "paste" : "file",
  );
  const renderPreview = (revision: Parameters<typeof Preview>[0]["revision"], compact: boolean) => (
    <Preview revision={revision} compact={compact} />
  );
  return (
    <AppShell current="bring" account={account} className="bring-page">
      <main className="bring-main" id="main">
        <header className="bring-heading">
          <h1 id="bring-title">Сохранить работу</h1>
          <p>
            Загрузите файл или вставьте код. Проще всего — попросить агента: он
            сохранит работу сам.
          </p>
        </header>
        <div className="bring-capture">
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
                renderResult={(saved, restart) => (
                  <SavedWork
                    {...saved}
                    headingId="paste-code-title"
                    renderPreview={renderPreview}
                    onRestart={restart}
                    restartLabel="Вставить другой код"
                  />
                )}
                titled={false}
              />
            )}
          </Tabs>
        </div>
        <aside className="bring-facts" aria-label="О сохранении">
          <a className="bring-fact bring-fact--link" href="/settings/agents">
            <Bot />
            <div>
              <strong>Сохраняйте прямо с агентом</strong>
              <p>
                Claude, Claude Code, Codex или другой MCP-клиент <ArrowUpRight />
              </p>
            </div>
          </a>
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
        </aside>
      </main>
    </AppShell>
  );
}
