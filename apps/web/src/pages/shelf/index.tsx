import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { Button, Chip, IconButton, Segmented } from "../../shared/ui/controls.tsx";
import {
  Bot,
  Compass,
  FileUp,
  Folder as FolderIcon,
  Grid2X2,
  List,
  Search,
  X,
} from "lucide-react";
import type {
  Account,
  Artifact,
  Folder,
} from "../../../../../packages/contracts/index.ts";
import { ShelfCard, seriesCounts, type CardAction } from "../../widgets/shelf-card/index.ts";
import { AgentHero } from "../../features/agent-hero/index.tsx";
import {
  categoryLabel,
  categoryOf,
  type Category,
} from "../../entities/artifact/format.ts";

export type ShelfSort = "newest" | "oldest" | "title";
export type { CardAction };
type Props = {
  account: Account;
  activeFolder: Folder | undefined;
  items: Artifact[];
  query: string;
  view: "grid" | "list";
  sort: ShelfSort;
  loading: boolean;
  loadingMore: boolean;
  cursor: string | null;
  focusSearch: boolean;
  setQuery: (query: string) => void;
  setView: (view: "grid" | "list") => void;
  setSort: (sort: ShelfSort) => void;
  setPanel: (panel: "upload" | "folder") => void;
  open: (id: string, panel?: CardAction) => void;
  loadMore: () => void;
};

const categories: Category[] = ["pages", "documents", "images", "other"];

export function ShelfPage({
  account,
  activeFolder,
  items,
  query,
  view,
  sort,
  loading,
  loadingMore,
  cursor,
  focusSearch,
  setQuery,
  setView,
  setSort,
  setPanel,
  open,
  loadMore,
}: Props) {
  const [category, setCategory] = useState<Category | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSearch) searchRef.current?.focus();
  }, [focusSearch]);
  const counts = useMemo(() => {
    const result: Record<Category, number> = { pages: 0, documents: 0, images: 0, other: 0 };
    for (const a of items) result[categoryOf(a.revision)]++;
    return result;
  }, [items]);
  const active = category && counts[category] ? category : null;
  const visible = useMemo(() => {
    const list = active ? items.filter((a) => categoryOf(a.revision) === active) : [...items];
    if (sort === "title") list.sort((x, y) => x.title.localeCompare(y.title, "ru"));
    else if (sort === "oldest") list.sort((x, y) => x.updatedAt.localeCompare(y.updatedAt));
    return list;
  }, [items, active, sort]);
  // Works that share a title prefix («Y360 Radar · …») get a small series badge.
  const series = useMemo(() => seriesCounts(items), [items]);
  return (
    <>
      {activeFolder ? (
        <header className="shelf-folder-heading">
          <span className="eyebrow">Папка</span>
          <h1>{activeFolder.name}</h1>
        </header>
      ) : (
        <AgentHero account={account} onUpload={() => setPanel("upload")} />
      )}

      <section
        className="shelf-library"
        aria-label="Сохранённые работы"
        aria-busy={loading}
      >
        <div className="shelf-library-head">
          <h2>
            {query ? "Результаты поиска" : activeFolder ? "В этой папке" : "Моя полка"}
          </h2>
          <div className="shelf-tools">
            <label className="ui-search ui-search--quiet shelf-search">
              <Search aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Поиск по полке"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по полке"
              />
              {query && (
                <IconButton size="sm" label="Очистить поиск" onClick={() => setQuery("")}>
                  <X />
                </IconButton>
              )}
            </label>
            <label className="shelf-sort">
              <span className="sr-only">Порядок</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as ShelfSort)}>
                <option value="newest">Сначала новые</option>
                <option value="oldest">Сначала старые</option>
                <option value="title">По названию</option>
              </select>
            </label>
            <Segmented
              label="Вид полки"
              value={view}
              onChange={setView}
              options={[
                { id: "grid", label: <Grid2X2 />, title: "Карточки" },
                { id: "list", label: <List />, title: "Список" },
              ]}
            />
          </div>
        </div>
        {items.length > 0 && (
          <div className="ui-chips shelf-chips" role="group" aria-label="Тип работы">
            <Chip pressed={active === null} onClick={() => setCategory(null)} count={items.length}>
              Все
            </Chip>
            {categories
              .filter((c) => counts[c] > 0)
              .map((c) => (
                <Chip key={c} pressed={active === c} onClick={() => setCategory(c)} count={counts[c]}>
                  {categoryLabel[c]}
                </Chip>
              ))}
          </div>
        )}

        {loading ? (
          <div className="shelf-gallery shelf-gallery--skeleton" role="status" aria-label="Загружаем работы…">
            {[0, 1, 2].map((i) => (
              <div key={i} className="shelf-card">
                <div className="shelf-cover placeholder" />
              </div>
            ))}
          </div>
        ) : visible.length ? (
          <>
            <div className={view === "grid" ? "shelf-gallery" : "shelf-list"}>
              {visible.map((a) => (
                <ShelfCard key={a.id} a={a} view={view} series={series} open={open} />
              ))}
            </div>
            {cursor && !active && sort === "newest" && (
              <div className="shelf-more">
                <Button busy={loadingMore} onClick={loadMore}>
                  Показать ещё
                </Button>
              </div>
            )}
            {cursor && (active || sort !== "newest") && (
              <p className="shelf-more-note">
                {active ? "Фильтр" : "Порядок"} действует на загруженные работы.{" "}
                <button type="button" className="text-button" onClick={loadMore} disabled={loadingMore}>
                  Загрузить ещё
                </button>
              </p>
            )}
          </>
        ) : !activeFolder && !query ? (
          <p className="shelf-empty-quiet" role="note">
            Здесь появятся ваши работы: страницы, отчёты, прототипы и изображения. Каждая хранится
            версиями, а кто может её открыть, решаете вы. Попросите агента: «Сохрани это на Полку» —
            или{" "}
            <button type="button" className="text-button" onClick={() => setPanel("upload")}>
              загрузите файл
            </button>
            .
          </p>
        ) : (
          <div className="shelf-empty">
            <div className="empty-icon">{query ? <Search /> : <FolderIcon />}</div>
            <h2>
              {query
                ? "Ничего не нашлось"
                : activeFolder
                  ? "В этой папке пока пусто"
                  : "На полке пока пусто"}
            </h2>
            <p>
              {query
                ? "Попробуйте другое название."
                : activeFolder
                  ? "Загрузите файл сюда или перенесите сохранённую работу через её меню «Название и папка»."
                  : "Здесь появятся страницы, отчёты и прототипы, которые сохраните вы или ваш агент. Каждая хранится версиями; сначала её видите только вы, ссылку включаете сами."}
            </p>
            {query ? (
              <Button onClick={() => setQuery("")}>Сбросить поиск</Button>
            ) : (
              <>
                <div className="button-row">
                  <Button variant="primary" onClick={() => setPanel("upload")}>
                    <FileUp /> Загрузить файл
                  </Button>
                </div>
                <div className="shelf-empty-links">
                  <a href="/settings/agents"><Bot /> Подключить агента</a>
                  <a href="/discover"><Compass /> Посмотреть примеры</a>
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}
