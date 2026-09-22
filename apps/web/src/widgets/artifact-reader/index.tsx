import {Tabs} from "../../shared/ui/Tabs.tsx";
import {ActionMenu} from "../../shared/ui/ActionMenu.tsx";
import React from "react";
import { Badge, Button } from "../../shared/ui/controls.tsx";
import {
  LockKeyhole,
  Link as LinkIcon,
  Upload,
  Trash2,
  Clock3,
  Check,
  Download,
  FileText,
  Image as ImageIcon,
  Sparkles,
  Share2,
} from "lucide-react";
import type {
  Artifact,
  Revision,
} from "../../../../../packages/contracts/index.ts";
import {
  date,
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
};
/** Read-only composition. The page owns fetching, mutations and asynchronous races. */
export function ArtifactReader({
  work,
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
}: Props) {
  const profile = profileView(work.revision);
  const linked =
    !!work.share && ["active", "behind"].includes(work.share.status);
  const KindIcon = isImage(shown) ? ImageIcon : FileText;
  return (
    <>
      <div className="work-heading" aria-label={`${folderName} · ${work.title}`}>
        <div className="work-heading-start">
          {(work.trashedAt || shown.mime !== "text/plain") && (
            <h1>{work.title}</h1>
          )}
          <div className="meta">
            <Badge tone={linked ? "success" : "neutral"}>
              {linked ? <LinkIcon /> : <LockKeyhole />}
              {status(work)}
            </Badge>
            <span>
              {work.trashedAt
                ? "В корзине · только скачивание"
                : `Просмотр · v${shown.number}`}
            </span>
          </div>
        </div>
        {!work.trashedAt && (
          <div className="button-row">
            <Button onClick={()=>setPanel("agent-context")}>
              <Sparkles />
              Скопировать для агента
            </Button>
            <Button onClick={() => setPanel("version")}>
              <Upload />
              Новая версия
            </Button>
            <Button
              variant="primary"
              onClick={() => setPanel("share")}
              disabled={!profile?.linkable && !work.share}
              title={profile?.linkable ? undefined : profile?.text}
            >
              <Share2 />
              Поделиться
            </Button>
            <ActionMenu items={[
              {id:"metadata",label:"Название и папка",onSelect:()=>setPanel("metadata")},
              {id:"trash",label:"В корзину",icon:<Trash2/>,onSelect:()=>setPanel("trash")},
            ]}/>

          </div>
        )}
      </div>
      {!work.trashedAt && work.revision.mime === "text/html" && profile && (
        <p className="history-note" role="note">
          <strong>{profile.label}.</strong> {profile.text}
        </p>
      )}
      <Tabs label="Материал и версии" value={history?"history":"material"} onChange={value=>setHistory(value==="history")} items={[
        {id:"material",label:"Материал"},
        {id:"history",label:<><Clock3/>Версии <span>{revisions.length}</span></>},
      ]} trailing={<span className="muted">{kindOf(shown)} · {size(shown.size)}</span>}>
      {history && (
        <div className="reader-versions" aria-label="Версии материала">
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
      {viewed && viewed.id !== work.revision.id && (
        <p className="history-note">
          Вы смотрите версию {viewed.number}. Новые сохранения и ссылка не
          изменяются.
          <Button variant="quiet" onClick={() => setViewed(null)}>
            К текущей версии
          </Button>
        </p>
      )}
      <section className="stage" data-kind={shown.mime === "text/plain" ? "text" : isImage(shown) ? "image" : "page"}>
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
      <div className="work-foot">
        <span className="work-foot-file">
          <KindIcon />
          {kindOf(shown)} · {size(shown.size)}
          <em>{shown.filename}</em>
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
      </div>
    </>
  );
}
