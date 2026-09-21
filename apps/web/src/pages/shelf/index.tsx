import React from "react";
import { Button, LinkButton } from "../../shared/ui/controls.tsx";
import {
  Plus,
  Upload,
  Folder as FolderIcon,
  ChevronRight,
  ArrowLeft,
  Search,
  X,
  Grid2X2,
  List,
  Image as ImageIcon,
  FileText,
  Link as LinkIcon,
  LockKeyhole,
  ArrowUpRight,
  PlugZap,
  Compass,
} from "lucide-react";
import type {
  Artifact,
  Folder,
} from "../../../../../packages/contracts/index.ts";
import { Preview } from "../../widgets/artifact-preview/index.ts";
import {
  date,
  status,
  isImage,
  kindOf,
} from "../../entities/artifact/format.ts";
type Props = {
  activeFolder: Folder | undefined;
  folderId: string | null;
  folders: Folder[];
  items: Artifact[];
  query: string;
  view: "grid" | "list";
  loading: boolean;
  loadingMore: boolean;
  cursor: string | null;
  setFolderId: (id: string | null) => void;
  setQuery: (query: string) => void;
  setView: (view: "grid" | "list") => void;
  setPanel: (panel: "upload" | "folder") => void;
  open: (id: string) => void;
  loadMore: () => void;
};
export function ShelfPage({
  activeFolder,
  folderId,
  folders,
  items,
  query,
  view,
  loading,
  loadingMore,
  cursor,
  setFolderId,
  setQuery,
  setView,
  setPanel,
  open,
  loadMore,
}: Props) {
  return (
    <>
      <div className="shelf-heading">
        <div>
          <span className="eyebrow">ВАШИ РАБОТЫ · ВСЕГДА ПОД РУКОЙ</span>
          <h1>{activeFolder?.name ?? "Моя Полка"}</h1>
          <p className="muted">
            {activeFolder
              ? "Всё по одной теме. Откройте работу и продолжите с того места, где остановились."
              : "Хорошие идеи не теряются в чатах. Здесь — ваши работы и их версии."}
          </p>
        </div>
        <div className="shelf-actions">
          <LinkButton variant="primary" href={folderId ? `/bring?folder=${encodeURIComponent(folderId)}` : "/bring"}>
            <Plus />
            Сохранить работу
          </LinkButton>
          <Button onClick={() => setPanel("upload")}>
            <Upload />
            Загрузить файл
          </Button>
        </div>
      </div>
      {!folderId && folders.length > 0 && (
        <section className="shelf-folders" aria-label="Папки">
          <div className="shelf-section-heading">
            <h2>
              Папки <span>{folders.length}</span>
            </h2>
            <Button variant="quiet" onClick={() => setPanel("folder")}>
              <Plus /> Новая папка
            </Button>
          </div>
          <div className="folder-chips">
            {folders.map((f) => (
              <Button key={f.id} onClick={() => setFolderId(f.id)}>
                <FolderIcon />
                <span>{f.name}</span>
                <ChevronRight />
              </Button>
            ))}
          </div>
        </section>
      )}
      <section
        className="shelf-library"
        aria-label="Сохранённые работы"
        aria-busy={loading}
      >
        <div className="shelf-section-heading shelf-library-heading">
          <div>
            {activeFolder && (
              <Button
                variant="quiet" className="shelf-back"
                onClick={() => setFolderId(null)}
              >
                <ArrowLeft /> Все работы
              </Button>
            )}
            <h2>
              {query
                ? "Результаты поиска"
                : activeFolder
                  ? "В этой папке"
                  : "Все работы"}
            </h2>
          </div>
          <span className="shelf-order">Последние изменения</span>
        </div>
        <div className="shelf-tools">
          <label className="search">
            <Search />
            <input
              aria-label="Найти работу"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Найти на Полке…"
            />
            {query && (
              <Button
                className="icon small"
                aria-label="Очистить поиск"
                onClick={() => setQuery("")}
              >
                <X />
              </Button>
            )}
          </label>
          <div className="segmented compact" role="group" aria-label="Вид Полки">
            <Button
              aria-label="Карточки"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <Grid2X2 />
            </Button>
            <Button
              aria-label="Список"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <List />
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="empty" role="status">
            Загружаем работы…
          </div>
        ) : items.length ? (
          <>
            {view === "list" && (
              <div className="shelf-list-heading" aria-hidden="true">
                <span>Работа</span>
                <span>Доступ</span>
                <span />
              </div>
            )}
            <div className={view === "grid" ? "gallery" : "file-list"}>
              {items.map((a) => (
                <a
                  className="artifact-card"
                  aria-label={`Открыть ${a.title}`}
                  key={a.id}
                  href={`/works/${a.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    open(a.id);
                  }}
                >
                  <div className="cover">
                    <Preview revision={a.revision} compact />
                  </div>
                  <div className="card-details">
                    <h3>{a.title}</h3>
                    <p>
                      {isImage(a.revision) ? <ImageIcon /> : <FileText />}
                      <span>
                        {kindOf(a.revision)} · v{a.revision.number}
                      </span>
                      <span className="card-date">{date(a.updatedAt)}</span>
                    </p>
                  </div>
                  <div className="shelf-card-footer">
                    <span className="card-access">
                      {a.share &&
                      ["active", "behind"].includes(a.share.status) ? (
                        <LinkIcon />
                      ) : (
                        <LockKeyhole />
                      )}
                      <span>{status(a)}</span>
                    </span>
                    <span className="shelf-card-open">
                      Открыть <ArrowUpRight />
                    </span>
                  </div>
                </a>
              ))}
            </div>
            {cursor && (
              <Button
                className="load-more"
                busy={loadingMore}
                onClick={loadMore}
              >
                Показать ещё
              </Button>
            )}
          </>
        ) : (
          <div className="empty">
            <div className="empty-icon">
              {query ? <Search /> : <FolderIcon />}
            </div>
            <h2>
              {query
                ? "Ничего не нашлось"
                : activeFolder
                  ? "Первая работа в этой папке"
                  : "Сохраните то, к чему хочется вернуться"}
            </h2>
            <p>
              {query
                ? "Попробуйте другое название."
                : activeFolder
                  ? "Загрузите файл сюда или перенесите сохранённую работу через её меню «Название и папка»."
                  : "Отчёт, заметку или страницу из чата. Загрузите файл — он останется на вашей полке вместе с новыми версиями."}
            </p>
            {query && (
              <Button onClick={() => setQuery("")}>Сбросить поиск</Button>
            )}
            {!query && (
              <>
                <div className="button-row">
                  <LinkButton variant="primary" href={folderId ? `/bring?folder=${encodeURIComponent(folderId)}` : "/bring"}>
                    <LinkIcon />
                    Сохранить работу
                  </LinkButton>
                  <Button onClick={() => setPanel("upload")}>
                    <Upload />
                    Загрузить файл с компьютера
                  </Button>
                </div>
                <a className="login-explore" href="/settings/agents">
                  <PlugZap /> Подключить агента
                </a>
                <a className="login-explore" href="/discover">
                  <Compass /> Посмотреть публичные примеры
                </a>
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}
