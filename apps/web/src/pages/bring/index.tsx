import { Tabs } from "../../shared/ui/Tabs.tsx";
import React, { useState } from "react";
import {
  ArrowUpRight,
  Bot,
  FileUp,
  Link2,
  LockKeyhole,
  Layers,
} from "lucide-react";
import { FileSave } from "../../features/capture-file/index.tsx";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { UrlImportCard } from "../../features/import-url/card.tsx";
import { Preview } from "../../widgets/artifact-preview/index.ts";

type Tab = "url" | "file";

/** File capture and capability-gated URL import. */
export function Bring() {
  const account = useAccount();
  const params = new URLSearchParams(location.search);
  const [initialFolderId] = useState(() => params.get("folder") ?? "");
  const folderQuery = initialFolderId ? `folder=${encodeURIComponent(initialFolderId)}&` : "";
  const [pasted] = useState(() => params.get("url") ?? "");
  const [tab, setTab] = useState<Tab>(
    location.hash === "#file" || !params.has("url") ? "file" : "url",
  );
  const toFile = () => {
    setTab("file");
    history.replaceState(null, "", `/bring${folderQuery ? "?" + folderQuery.slice(0, -1) : ""}#file`);
  };
  const toUrl = () => {
    setTab("url");
    history.replaceState(null, "", `/bring?${folderQuery}url=${encodeURIComponent(pasted)}`);
  };
  return (
    <AppShell
      current="bring"
      account={account}
      className="bring-page entry-redesign capture-redesign"
    >
      <main className="bring-main bring-simple" id="main">
        <header className="entry-heading">
          <span className="entry-eyebrow">ИЗ ЧАТА — НА ВАШУ ПОЛКУ</span>
          <h1 id="bring-title">Сохранить работу.</h1>
          <p>
            Отчёт, страницу или хорошую идею. Чтобы открыть снова, продолжить и
            поделиться.
          </p>
        </header>
        <div className="capture-layout">
          <div className="capture-workspace">
            <Tabs
              label="Как сохранить"
              value={tab}
              onChange={(next) => (next === "file" ? toFile() : toUrl())}
              items={
                [
                  {
                    id: "file",
                    label: (
                      <>
                        <FileUp />
                        Загрузить файл
                      </>
                    ),
                  },
                  {
                    id: "url",
                    label: (
                      <>
                        <Link2 />
                        По ссылке
                      </>
                    ),
                  },
                ] as const
              }
            >
              <div hidden={tab !== "url"}>
                <UrlImportCard
                  initial={pasted}
                  initialFolderId={initialFolderId}
                  onFile={toFile}
                  accountId={account?.id}
                  fileSave={
                    <FileSave
                      account={account}
                      initialFolderId={initialFolderId}
                      renderPreview={(revision, compact) => (
                        <Preview revision={revision} compact={compact} />
                      )}
                    />
                  }
                />
              </div>
              <div hidden={tab !== "file"}>
                <FileSave
                  account={account}
                  initialFolderId={initialFolderId}
                  renderPreview={(revision, compact) => (
                    <Preview revision={revision} compact={compact} />
                  )}
                />
              </div>
            </Tabs>
          </div>
          <aside className="capture-context" aria-label="О сохранении">
            <div className="capture-fact">
              <LockKeyhole />
              <div>
                <h2>Сначала — только для вас</h2>
                <p>
                  Сохранённая работа появится на личной полке. Доступ по ссылке
                  вы включаете отдельно.
                </p>
              </div>
            </div>
            <div className="capture-fact">
              <Layers />
              <div>
                <h2>Можно вернуться к версии</h2>
                <p>
                  Обновляйте работу на её странице. Предыдущие сохранения
                  останутся в истории.
                </p>
              </div>
            </div>
            <a className="capture-agent" href="/settings/agents">
              <Bot />
              <div>
                <strong>Сохраняйте прямо с агентом</strong>
                <p>Подключите Claude, Codex или другой MCP-клиент.</p>
                <span>
                  Настроить подключение <ArrowUpRight />
                </span>
              </div>
            </a>
          </aside>
        </div>
      </main>
    </AppShell>
  );
}
