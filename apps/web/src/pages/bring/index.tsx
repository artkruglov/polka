import "./styles.css";
import React, { useState } from "react";
import { ArrowUpRight, Bot, Layers, LockKeyhole } from "lucide-react";
import { FileSave } from "../../features/capture-file/index.tsx";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { UrlImportCard } from "../../features/import-url/card.tsx";
import { Preview } from "../../widgets/artifact-preview/index.ts";

/** File capture and capability-gated URL import: one column, the link first, the file below. */
export function Bring() {
  const account = useAccount();
  const params = new URLSearchParams(location.search);
  const [initialFolderId] = useState(() => params.get("folder") ?? "");
  const [pasted] = useState(() => params.get("url") ?? "");
  // A recognised Claude/ChatGPT link shows its own file drop; the standalone one steps aside.
  const [providerGuide, setProviderGuide] = useState(false);
  const toFile = () =>
    document.getElementById("file")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const renderPreview = (revision: Parameters<typeof Preview>[0]["revision"], compact: boolean) => (
    <Preview revision={revision} compact={compact} />
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
              account={account}
              initialFolderId={initialFolderId}
              renderPreview={renderPreview}
              embedded
            />
          }
        />
        <div className="bring-or" hidden={providerGuide} aria-hidden={providerGuide}>
          <span>или</span>
        </div>
        <div hidden={providerGuide}>
          <FileSave
            account={account}
            initialFolderId={initialFolderId}
            renderPreview={renderPreview}
          />
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
                Claude Code, Codex или другой MCP-клиент <ArrowUpRight />
              </p>
            </div>
          </a>
        </aside>
      </main>
    </AppShell>
  );
}
