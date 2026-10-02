import React, { useEffect, useMemo, useRef } from "react";
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
import type { Shelf, ShelfCounts } from "../../shared/api/client.ts";
import { ROLE_LABEL, atLeast } from "../../entities/shelf/model.ts";
import { categoryLabel, type Category } from "../../entities/artifact/format.ts";

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
  /** The chosen chip; the server filters by it. */
  kind: Category | null;
  setKind: (kind: Category | null) => void;
  /** Only works with an accepted version. */
  acceptedOnly: boolean;
  setAcceptedOnly: (value: boolean) => void;
  /** Works of each kind over the whole shelf (the first page's counts). */
  counts: ShelfCounts | null;
  /** The last request failed: what is shown may be out of date. */
  stale?: boolean;
  /** «В корзину» from a card's menu: confirm in place, stay on the shelf. */
  onTrash?: (artifact: Artifact) => void;
  /** A department shelf (docs/specs/TEAM_SHELVES.md); absent on one's own. */
  team?: Shelf | null;
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
  kind,
  setKind,
  acceptedOnly,
  setAcceptedOnly,
  counts,
  stale = false,
  onTrash,
  team,
}: Props) {
  const canSave = !team || atLeast(team.role, "author");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSearch) searchRef.current?.focus();
  }, [focusSearch]);
  // The server sorts, filters and counts the whole shelf (GET /api/artifacts).
  const active = kind;
  const visible = items;
  const showChips = counts ? counts.all > 0 : loading && !query;
  // Works that share a title prefix («Y360 Radar · …») get a small series badge.
  const series = useMemo(() => seriesCounts(items), [items]);
  return (
    <>
      {activeFolder ? (
        <header className="shelf-folder-heading">
          <span className="eyebrow">Папка</span>
          <h1>{activeFolder.name}</h1>
        </header>
      ) : team ? (
        <header className="shelf-folder-heading">
          <span className="eyebrow">Полка отдела · вы — {ROLE_LABEL[team.role].toLowerCase()}</span>
          <h1>{team.name}</h1>
          <p className="shelf-team-lead">
            Работы здесь видят все участники полки и находят поиском. Они принадлежат отделу: если
            сотрудник уходит, работы остаются.
          </p>
          {canSave && (
            <div className="button-row">
              <Button variant="primary" onClick={() => setPanel("upload")}>
                <FileUp /> Сохранить сюда
              </Button>
            </div>
          )}
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
            {query ? "Результаты поиска" : activeFolder ? "В этой папке" : team ? "Все работы" : "Моя полка"}
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
        {(showChips || acceptedOnly) && (
          <div className="ui-chips shelf-chips" role="group" aria-label="Фильтры полки">
            <Chip pressed={active === null} onClick={() => setKind(null)} count={counts?.all}>
              Все
            </Chip>
            {counts &&
              categories
                .filter((c) => counts[c] > 0 || active === c)
                .map((c) => (
                  <Chip key={c} pressed={active === c} onClick={() => setKind(c)} count={counts[c]}>
                    {categoryLabel[c]}
                  </Chip>
                ))}
            <Chip pressed={acceptedOnly} onClick={() => setAcceptedOnly(!acceptedOnly)}>
              Принятые
            </Chip>
          </div>
        )}
        {stale && (
          <p className="shelf-stale" role="status">
            Нет связи с Полкой: {items.length ? "показаны прежние результаты, они могли устареть" : "результаты не загрузились"}.
          </p>
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
            <div
              className={view === "grid" ? "shelf-gallery" : "shelf-list"}
              data-stale={stale || undefined}
            >
              {visible.map((a) => (
                <ShelfCard key={a.id} a={a} view={view} series={series} open={open} onTrash={onTrash} />
              ))}
            </div>
            {cursor && (
              <div className="shelf-more">
                <Button busy={loadingMore} onClick={loadMore}>
                  Показать ещё
                </Button>
              </div>
            )}
          </>
        ) : stale ? null : active || acceptedOnly ? (
          <div className="shelf-empty">
            <div className="empty-icon"><FolderIcon /></div>
            <h2>Таких работ нет</h2>
            <p>
              {acceptedOnly
                ? `Здесь нет работ с принятой версией${active ? " этого типа" : ""}${query ? " по вашему запросу" : ""}. Принять версию можно в меню работы.`
                : `Здесь нет работ этого типа${query ? " по вашему запросу" : ""}.`}
            </p>
            <Button onClick={() => { setKind(null); setAcceptedOnly(false); }}>Показать все</Button>
          </div>
        ) : team && !query ? (
          <p className="shelf-empty-quiet" role="note">
            {activeFolder ? "В этой папке пока пусто." : "На полке отдела пока пусто."}{" "}
            {canSave
              ? "Сохраните работу сюда — её увидят все участники."
              : "Здесь появятся работы, которые сохранят участники."}
          </p>
        ) : !activeFolder && !query ? (
          <div className="shelf-start" role="note">
            <header>
              <h2>Здесь появятся ваши работы</h2>
              <p>
                Страницы, отчёты, прототипы и целые папки проектов. Каждая хранится версиями, а кто может её
                открыть, решаете вы. Попросите агента: «Сохрани это на Полку».
              </p>
            </header>
            <div className="shelf-start-grid">
              <a className="shelf-start-card shelf-start-card--main" href="/settings/agents">
                <span className="shelf-start-icon"><Bot /></span>
                <strong>Подключить агента</strong>
                <span>Claude, ChatGPT или Codex сохраняют работы сами и продолжают их в новых чатах.</span>
              </a>
              <button type="button" className="shelf-start-card" onClick={() => setPanel("upload")}>
                <span className="shelf-start-icon"><FileUp /></span>
                <strong>Загрузить файл</strong>
                <span>HTML, текст, изображение или папку проекта — прямо с компьютера.</span>
              </button>
              <a className="shelf-start-card" href="/discover">
                <span className="shelf-start-icon"><Compass /></span>
                <strong>Посмотреть примеры</strong>
                <span>Что уже делают с агентами: исследования, разборы и инструменты.</span>
              </a>
            </div>
          </div>
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
