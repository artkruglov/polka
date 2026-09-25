import { TabList, tabId } from "../../shared/ui/Tabs.tsx";
import { ActionMenu, type MenuAction } from "../../shared/ui/ActionMenu.tsx";
import { Popover } from "../../shared/ui/Popover.tsx";
import React, { useEffect, useId, useState } from "react";
import { Button, IconButton } from "../../shared/ui/controls.tsx";
import { useCopy } from "../../shared/ui/CopyText.tsx";
import { improvePhrase } from "../../entities/artifact/agent-phrases.ts";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  Download,
  Ellipsis,
  Folder as FolderIcon,
  Info,
  Maximize2,
  MessageCircle,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
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
/** The reader's views; «versions» is kept in the address as ?tab=versions. */
export type ReaderTab = "work" | "versions";
export const readerTabFromSearch = (search: string): ReaderTab =>
  new URLSearchParams(search).get("tab") === "versions" ? "versions" : "work";
/** The same address with the tab set; «work» is the default and leaves no trace. */
export function withReaderTab(href: string, tab: ReaderTab): string {
  const url = new URL(href);
  if (tab === "versions") url.searchParams.set("tab", "versions");
  else url.searchParams.delete("tab");
  return `${url.pathname}${url.search}${url.hash}`;
}
/** The work's comments, when its links have any (docs/specs/COMMENTS.md). */
export type ReaderComments = {
  label: string;
  count: number;
  unread: number;
  open: boolean;
  onToggle: () => void;
};
type Props = {
  work: Artifact;
  /** The address of this page, named in the phrase the owner copies for the agent. */
  shelfUrl: string;
  shown: Revision;
  revisions: Revision[];
  viewed: Revision | null;
  /** The folder the work lives in; named in the details. */
  folderName: string;
  history: boolean;
  setHistory: (value: boolean) => void;
  setViewed: (value: Revision | null) => void;
  setPanel: (value: ReaderAction) => void;
  preview: React.ReactNode;
  onDownload: () => void;
  /** Back to the shelf. */
  onBack?: () => void;
  /** «На весь экран» targets the stage. */
  stageRef?: React.Ref<HTMLElement>;
  onFullscreen?: () => void;
  comments?: ReaderComments;
  /** Version comparison, shown under the version list in «Версии». */
  compare?: React.ReactNode;
  /** The page's notices, under the bar. */
  notices?: React.ReactNode;
};

/** Everything but sharing and reading lives in «…», in this order. */
export function workMenu({
  work,
  shown,
  setPanel,
  onDownload,
  onCopyForAgent,
}: Pick<Props, "work" | "shown" | "setPanel" | "onDownload"> & {
  onCopyForAgent: () => void;
}): MenuAction[] {
  const download: MenuAction = {
    id: "download",
    label:
      shown.storageKind === "bundle"
        ? "Скачать весь пакет"
        : "Скачать оригинал",
    icon: <Download />,
    onSelect: onDownload,
  };
  if (work.trashedAt) return [download];
  return [
    {
      id: "copy-for-agent",
      label: "Скопировать для агента",
      icon: <Sparkles />,
      onSelect: onCopyForAgent,
    },
    {
      id: "agent-context",
      label: "Подробный контекст для агента",
      icon: <Bot />,
      onSelect: () => setPanel("agent-context"),
    },
    {
      id: "version",
      label: "Новая версия",
      icon: <Upload />,
      onSelect: () => setPanel("version"),
    },
    {
      id: "rework",
      label: "Переработать с агентом",
      icon: <WandSparkles />,
      onSelect: () => setPanel("rework"),
    },
    download,
    {
      id: "metadata",
      label: "Название и папка",
      icon: <FolderIcon />,
      onSelect: () => setPanel("metadata"),
    },
    {
      id: "trash",
      label: "В корзину",
      icon: <Trash2 />,
      tone: "danger",
      onSelect: () => setPanel("trash"),
    },
  ];
}

/**
 * The owner's work page: one slim bar (back, title, version, tabs, actions)
 * and the work filling the rest of the screen. The page owns fetching,
 * mutations and asynchronous races.
 */
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
  onBack,
  stageRef,
  onFullscreen,
  comments,
  compare,
  notices,
}: Props) {
  const ids = useId();
  const panelId = `${ids}-panel`;
  const tab: ReaderTab = history ? "versions" : "work";
  // The details describe the version on screen, which may be an older one.
  const profile = profileView(shown);
  const current = profileView(work.revision);
  const plainText = shown.mime === "text/plain" && !work.trashedAt;
  // «Скопировать для агента» copies one phrase; the full context stays in the menu.
  const phrase = improvePhrase(work.title, shelfUrl);
  const agent = useCopy(phrase);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyForAgent = async () => {
    const result = await agent.copy();
    if (result === "failed") setPanel("agent-context");
    else if (result === "copied") setCopied(true);
  };
  const Title = plainText ? "p" : "h1";
  return (
    <div className="work-reader">
      <header className="work-bar" aria-label={`${folderName} · ${work.title}`}>
        <div className="work-bar-lead">
          {onBack && (
            <IconButton label="Назад на полку" size="sm" onClick={onBack}>
              <ArrowLeft />
            </IconButton>
          )}
          {/* The text itself carries the large title; the bar keeps one h1 for other kinds. */}
          <Title className="work-bar-title" title={work.title}>
            {work.title}
          </Title>
        </div>
        <div className="work-bar-nav">
          <ActionMenu
            label={`Версия ${shown.number} из ${revisions.length}: выбрать версию`}
            className="work-version"
            placement="start"
            icon={
              <span className="work-version-chip">
                v{shown.number}
                <ChevronDown aria-hidden="true" />
              </span>
            }
            items={[
              ...revisions.map((r) => ({
                id: r.id,
                label: `Версия ${r.number} · ${date(r.createdAt)}${
                  work.share?.revisionId === r.id &&
                  ["active", "behind"].includes(work.share.status)
                    ? " · по ссылке"
                    : ""
                }`,
                icon:
                  shown.id === r.id ? (
                    <Check />
                  ) : (
                    <span className="work-version-blank" />
                  ),
                onSelect: () => {
                  setViewed(r.id === work.revision.id ? null : r);
                  setHistory(false);
                },
              })),
              {
                id: "all",
                label: "Все версии и сравнение",
                icon: <Clock3 />,
                onSelect: () => setHistory(true),
              },
            ]}
          />
          <TabList
            label="Работа и версии"
            className="work-tabs"
            idBase={ids}
            panelId={panelId}
            value={tab}
            onChange={(value) => setHistory(value === "versions")}
            items={[
              { id: "work", label: "Работа" },
              {
                id: "versions",
                label: (
                  <>
                    Версии <span>{revisions.length}</span>
                  </>
                ),
              },
            ]}
          />
        </div>
        <div className="work-bar-actions">
          <span className="work-bar-status" role="status">
            {copied && (
              <>
                <Check aria-hidden="true" /> Фраза для агента скопирована
              </>
            )}
          </span>
          {comments && (
            <Button
              variant="quiet"
              className="work-bar-comments"
              aria-pressed={comments.open}
              aria-controls="work-comments"
              aria-label={`${comments.label}: ${comments.count}${comments.unread ? `, новых ${comments.unread}` : ""}`}
              title={comments.label}
              onClick={comments.onToggle}
            >
              <MessageCircle /> {comments.count}
              {comments.unread > 0 && (
                <span className="work-bar-unread">+{comments.unread}</span>
              )}
            </Button>
          )}
          <Popover label="О работе" icon={<Info />} className="work-info">
            <dl className="work-info-list">
              <div>
                <dt>Вид</dt>
                <dd>
                  {work.trashedAt
                    ? "В корзине"
                    : shown.mime === "text/html"
                      ? profile.label
                      : kindOf(shown)}
                </dd>
              </div>
              <div>
                <dt>Доступ</dt>
                <dd>{status(work)}</dd>
              </div>
              <div>
                <dt>Версия</dt>
                <dd>
                  v{shown.number} · {dateTime(shown.createdAt)}
                </dd>
              </div>
              <div>
                <dt>Файл</dt>
                <dd>
                  {shown.filename} · {size(shown.size)}
                </dd>
              </div>
              <div>
                <dt>Папка</dt>
                <dd>{folderName}</dd>
              </div>
            </dl>
            {!work.trashedAt && (
              <p className="work-info-note">{profile.text}</p>
            )}
          </Popover>
          {!work.trashedAt && onFullscreen && (
            <IconButton
              label="На весь экран"
              size="sm"
              className="work-bar-fullscreen"
              onClick={onFullscreen}
            >
              <Maximize2 />
            </IconButton>
          )}
          {!work.trashedAt && (
            <Button
              variant="primary"
              className="work-bar-share"
              aria-label="Поделиться"
              onClick={() => setPanel("share")}
              disabled={!current.linkable && !work.share}
              title={current.linkable ? "Поделиться" : current.text}
            >
              <Share2 /> <span>Поделиться</span>
            </Button>
          )}
          <ActionMenu
            label="Ещё действия"
            icon={<Ellipsis />}
            className="work-more"
            items={workMenu({
              work,
              shown,
              setPanel,
              onDownload,
              onCopyForAgent: () => void copyForAgent(),
            })}
          />
        </div>
      </header>
      {notices}
      <div
        className="work-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(ids, tab)}
        tabIndex={0}
      >
        {history && (
          <div className="work-versions">
            <div
              className="reader-versions"
              role="group"
              aria-label="Выбор версии"
            >
              {revisions.map((r) => (
                <Button
                  key={r.id}
                  aria-pressed={shown.id === r.id}
                  onClick={() => {
                    setViewed(r.id === work.revision.id ? null : r);
                    setHistory(false);
                  }}
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
            {compare}
          </div>
        )}
        {viewed && viewed.id !== work.revision.id && (
          <p className="history-note" role="status">
            Вы смотрите версию {viewed.number}. Новые сохранения и ссылка не
            изменяются.
            <Button variant="quiet" onClick={() => setViewed(null)}>
              К текущей версии
            </Button>
          </p>
        )}
        {/* Stays mounted under «Версии»: a running page keeps its state. */}
        <section
          className="stage"
          ref={stageRef}
          hidden={history}
          aria-label={work.title}
          data-kind={
            shown.mime === "text/plain"
              ? "text"
              : isImage(shown)
                ? "image"
                : "page"
          }
        >
          {work.trashedAt ? (
            <div className="preview-error">
              <p>
                Работа в корзине. Просмотр отключён; версии и оригиналы доступны
                для скачивания.
              </p>
              <Button onClick={onDownload}>
                <Download />
                {shown.storageKind === "bundle"
                  ? "Скачать весь пакет"
                  : "Скачать оригинал"}
              </Button>
            </div>
          ) : (
            preview
          )}
        </section>
      </div>
    </div>
  );
}
