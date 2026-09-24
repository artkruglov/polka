import { Tabs } from "../../shared/ui/Tabs.tsx";
import { ActionMenu } from "../../shared/ui/ActionMenu.tsx";
import React from "react";
import { Badge, Button } from "../../shared/ui/controls.tsx";
import { useCopy } from "../../shared/ui/CopyText.tsx";
import { improvePhrase } from "../../entities/artifact/agent-phrases.ts";
import {
  LockKeyhole,
  Link as LinkIcon,
  Upload,
  Trash2,
  Clock3,
  Check,
  Download,
  FileText,
  Folder as FolderIcon,
  Image as ImageIcon,
  Sparkles,
  Ellipsis,
  Bot,
} from "lucide-react";
import type {
  Artifact,
  Revision,
} from "../../../../../packages/contracts/index.ts";
import {
  date,
  dateTime,
  size,
  status,
  kindOf,
  isImage,
  profileView,
} from "../../entities/artifact/format.ts";

export type ReaderAction =
  "share" | "version" | "metadata" | "trash" | "rework" | "agent-context";
type Props = {
  work: Artifact;
  /** The address of this page, named in the phrase the owner copies for the agent. */
  shelfUrl: string;
  shown: Revision;
  revisions: Revision[];
  viewed: Revision | null;
  /** Shown by the page's top bar; the reader only names it for assistive technology. */
  folderName: string;
  history: boolean;
  setHistory: (value: boolean) => void;
  setViewed: (value: Revision | null) => void;
  setPanel: (value: ReaderAction) => void;
  preview: React.ReactNode;
  onDownload: () => void;
  /** The page's «На весь экран» targets the stage. */
  stageRef?: React.Ref<HTMLElement>;
  /** Version comparison, shown under the version list in «Версии». */
  compare?: React.ReactNode;
};
/** Read-only composition. The page owns fetching, mutations and asynchronous races. */
export function ArtifactReader({
  work,
  shelfUrl,
  shown,
  revisions,
  viewed,
  folderName,
  history,
  setHistory,
  setViewed,
  setPanel,
  preview,
  onDownload,
  stageRef,
  compare,
}: Props) {
  // Badge and explanation describe the version on screen, which may be an older one.
  const profile = profileView(shown);
  const linked =
    !!work.share && ["active", "behind"].includes(work.share.status);
  const KindIcon = isImage(shown) ? ImageIcon : FileText;
  const plainText = shown.mime === "text/plain" && !work.trashedAt;
  // «Скопировать для агента» copies one phrase; the full context stays in the menu.
  const agent = useCopy(improvePhrase(work.title, shelfUrl));
  const copyForAgent = async () => {
    if ((await agent.copy()) === "failed") setPanel("agent-context");
  };
  return (
    <>
      <header className={`work-heading${plainText ? " work-heading--quiet" : ""}`} aria-label={`${folderName} · ${work.title}`}>
        <span className="eyebrow">
          {work.trashedAt
            ? "В корзине"
            : shown.mime === "text/html"
              ? profile.label
              : kindOf(shown)}
        </span>
        {!plainText && <h1>{work.title}</h1>}
        <div className="work-meta">
          <Badge tone={linked ? "accent" : "neutral"}>
            {linked ? <LinkIcon /> : <LockKeyhole />}
            {status(work)}
          </Badge>
          <span>
            {work.trashedAt
              ? "Только скачивание"
              : `v${shown.number} · ${date(shown.createdAt)}`}
          </span>
          <span>{kindOf(shown)} · {size(shown.size)}</span>
        </div>
      </header>
      {!work.trashedAt && shown.mime === "text/html" && (
        <p className="work-profile" role="note">
          {profile.text}
        </p>
      )}
      <Tabs
        label="Работа и версии"
        value={history ? "history" : "material"}
        onChange={(value) => setHistory(value === "history")}
        items={[
          { id: "material", label: "Работа" },
          {
            id: "history",
            label: (
              <>
                <Clock3 />
                Версии <span>{revisions.length}</span>
              </>
            ),
          },
        ]}
        trailing={
          !work.trashedAt ? (
            <div className="work-actions">
              <Button
                busy={agent.state === "copying"}
                onClick={() => void copyForAgent()}
                title={improvePhrase(work.title, shelfUrl)}
              >
                {agent.state === "copied" ? <Check /> : <Sparkles />}
                <span>{agent.state === "copied" ? "Скопировано" : "Скопировать для агента"}</span>
              </Button>
              <Button onClick={() => setPanel("version")}>
                <Upload />
                <span>Новая версия</span>
              </Button>
              <ActionMenu
                label="Ещё действия"
                icon={<Ellipsis />}
                items={[
                  { id: "agent-context", label: "Подробный контекст для агента", icon: <Bot />, onSelect: () => setPanel("agent-context") },
                  { id: "metadata", label: "Название и папка", icon: <FolderIcon />, onSelect: () => setPanel("metadata") },
                  { id: "trash", label: "В корзину", icon: <Trash2 />, tone: "danger", onSelect: () => setPanel("trash") },
                ]}
              />
            </div>
          ) : undefined
        }
      >
        {history && (
          <div className="reader-versions" role="group" aria-label="Выбор версии">
            {revisions.map((r) => (
              <Button
                key={r.id}
                aria-pressed={shown.id === r.id}
                onClick={() => setViewed(r)}
              >
                <span>
                  Версия {r.number}
                  {work.share?.revisionId === r.id &&
                    ["active", "behind"].includes(work.share.status) && (
                      <small>по ссылке</small>
                    )}
                </span>
                <small>{date(r.createdAt)}</small>
                {shown.id === r.id && <Check />}
              </Button>
            ))}
          </div>
        )}
        {history && compare}
        {viewed && viewed.id !== work.revision.id && (
          <p className="history-note" role="status">
            Вы смотрите версию {viewed.number}. Новые сохранения и ссылка не
            изменяются.
            <Button variant="quiet" onClick={() => setViewed(null)}>
              К текущей версии
            </Button>
          </p>
        )}
        <section
          className="stage"
          ref={stageRef}
          data-kind={shown.mime === "text/plain" ? "text" : isImage(shown) ? "image" : "page"}
        >
          {work.trashedAt ? (
            <div className="preview-error">
              Работа в корзине. Просмотр отключён; версии и оригиналы доступны для
              скачивания.
            </div>
          ) : (
            preview
          )}
        </section>
      </Tabs>
      <footer className="work-foot">
        <span className="work-foot-file">
          <Clock3 />
          <span>Сохранённая версия · {dateTime(shown.createdAt)}</span>
          <em>
            <KindIcon /> {shown.filename} · {size(shown.size)}
          </em>
        </span>
        <div className="work-foot-actions">
          <Button variant="quiet" onClick={onDownload}>
            <Download />
            {shown.storageKind === "bundle"
              ? "Скачать весь пакет"
              : "Скачать оригинал"}
          </Button>
          {!work.trashedAt && (
            <Button variant="quiet" onClick={() => setPanel("rework")}>
              <Sparkles /> Переработать с агентом
            </Button>
          )}
        </div>
      </footer>
    </>
  );
}
