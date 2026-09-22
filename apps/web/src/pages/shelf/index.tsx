import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { Button, Chip, IconButton, LinkButton, Segmented } from "../../shared/ui/controls.tsx";
import { ActionMenu } from "../../shared/ui/ActionMenu.tsx";
import {
  ArrowUpRight,
  Bot,
  Compass,
  Ellipsis,
  FileUp,
  Folder as FolderIcon,
  Grid2X2,
  Link as LinkIcon,
  List,
  LockKeyhole,
  Search,
  Share2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type {
  Artifact,
  Folder,
} from "../../../../../packages/contracts/index.ts";
import { Preview, TextCover } from "../../widgets/artifact-preview/index.ts";
import {
  accessLabel,
  categoryLabel,
  categoryOf,
  date,
  isImage,
  isLinked,
  kindOf,
  type Category,
} from "../../entities/artifact/format.ts";

export type ShelfSort = "newest" | "oldest" | "title";
export type CardAction = "share" | "metadata" | "trash";
type Props = {
  activeFolder: Folder | undefined;
  folderId: string | null;
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

/** The cover a card shows: the work itself when it can be drawn, otherwise a typographic cover. */
function CardCover({ a }: { a: Artifact }) {
  const r = a.revision;
  const drawable =
    isImage(r) ||
    (r.mime === "text/html" && r.htmlProfile !== "unsupported");
  if (drawable) return <Preview revision={r} compact />;
  return (
    <TextCover
      id={a.id}
      title={a.title}
      eyebrow={r.mime === "text/plain" ? "Заметка" : kindOf(r)}
      note={r.mime === "text/plain" ? undefined : "Просмотр недоступен"}
    />
  );
}

/** True once the element comes near the viewport; covers below the fold load no bytes or iframes until then. */
function useNearViewport<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (near || !node) return;
    if (typeof IntersectionObserver !== "function") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near] as const;
}

function CoverLink({
  a,
  href,
  onClick,
  cta,
}: {
  a: Artifact;
  href: string;
  onClick: (e: React.MouseEvent) => void;
  cta: boolean;
}) {
  const [ref, near] = useNearViewport<HTMLAnchorElement>();
  return (
    <a ref={ref} className="shelf-cover" href={href} onClick={onClick} aria-label={`Открыть ${a.title}`} tabIndex={-1}>
      {near ? <CardCover a={a} /> : <div className="placeholder" aria-hidden="true" />}
      {cta && (
        <span className="shelf-cover-cta" aria-hidden="true">
          Открыть <ArrowUpRight />
        </span>
      )}
    </a>
  );
}

export function ShelfPage({
  activeFolder,
  folderId,
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
  const bringHref = folderId ? `/bring?folder=${encodeURIComponent(folderId)}` : "/bring";
  const focusTools = () => searchRef.current?.focus();
  return (
    <>
      {activeFolder ? (
        <header className="shelf-folder-heading">
          <span className="eyebrow">Папка</span>
          <h1>{activeFolder.name}</h1>
        </header>
      ) : (
        <section className="shelf-hero" aria-label="Сохранить работу">
          <div className="shelf-hero-top">
            <IconButton label="Поиск по полке" onClick={focusTools}>
              <Search />
            </IconButton>
          </div>
          <h1>Сохраняйте. Делитесь. Возвращайтесь.</h1>
          <form
            className="shelf-hero-entry"
            action="/bring"
            method="get"
            onSubmit={(e) => {
              const input = e.currentTarget.elements.namedItem("url") as HTMLInputElement;
              if (!input.value.trim()) e.preventDefault();
            }}
          >
            <label className="shelf-hero-field">
              <LinkIcon aria-hidden="true" />
              <input
                type="url"
                name="url"
                inputMode="url"
                placeholder="Вставьте ссылку на артефакт"
                aria-label="Ссылка на артефакт"
              />
            </label>
            {folderId && <input type="hidden" name="folder" value={folderId} />}
            <Button type="submit" variant="primary" className="shelf-hero-save">
              Сохранить
            </Button>
            <span className="shelf-hero-divider" aria-hidden="true" />
            <div className="shelf-hero-agent">
              <LinkButton href="/settings/agents">
                <Bot /> Подключить агента
              </LinkButton>
              <span>Агент сохранит работу на полку, когда вы попросите</span>
            </div>
          </form>
          <p className="shelf-hero-fine">
            Или{" "}
            <button type="button" className="text-button" onClick={() => setPanel("upload")}>
              загрузите файл с компьютера
            </button>
            : HTML, текст или изображение до 5 МБ.
          </p>
        </section>
      )}

      <section
        className="shelf-library"
        aria-label="Сохранённые работы"
        aria-busy={loading}
      >
        <div className="shelf-library-head">
          <h2>{query ? "Результаты поиска" : activeFolder ? "В этой папке" : "Моя полка"}</h2>
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
              {visible.map((a) => {
                const href = `/works/${a.id}`;
                const go = (e: React.MouseEvent) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
                  e.preventDefault();
                  open(a.id);
                };
                const menu = (
                  <ActionMenu
                    label={`Действия: ${a.title}`}
                    icon={<Ellipsis />}
                    items={[
                      { id: "open", label: "Открыть", icon: <ArrowUpRight />, onSelect: () => open(a.id) },
                      { id: "share", label: "Поделиться", icon: <Share2 />, onSelect: () => open(a.id, "share") },
                      { id: "metadata", label: "Название и папка", icon: <FolderIcon />, onSelect: () => open(a.id, "metadata") },
                      { id: "trash", label: "В корзину", icon: <Trash2 />, tone: "danger", onSelect: () => open(a.id, "trash") },
                    ]}
                  />
                );
                return (
                  <article className="shelf-card" key={a.id}>
                    <CoverLink a={a} href={href} onClick={go} cta={view === "grid"} />
                    <div className="shelf-card-body">
                      <h3>
                        <a href={href} onClick={go}>{a.title}</a>
                      </h3>
                      <div className="shelf-card-meta">
                        <span className="shelf-card-access" title={accessLabel(a)}>
                          {isLinked(a) ? <Users /> : <LockKeyhole />}
                          {accessLabel(a)}
                        </span>
                        <span className="shelf-card-kind">
                          {kindOf(a.revision)} · v{a.revision.number} · {date(a.updatedAt)}
                        </span>
                      </div>
                    </div>
                    <div className="shelf-card-actions">
                      <a className="shelf-card-open" href={href} onClick={go}>
                        Открыть <ArrowUpRight />
                      </a>
                      {menu}
                    </div>
                  </article>
                );
              })}
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
        ) : (
          <div className="shelf-empty">
            <div className="empty-icon">{query ? <Search /> : <FolderIcon />}</div>
            <h2>
              {query
                ? "Ничего не нашлось"
                : activeFolder
                  ? "В этой папке пока пусто"
                  : "Сохраните то, к чему хочется вернуться"}
            </h2>
            <p>
              {query
                ? "Попробуйте другое название."
                : activeFolder
                  ? "Загрузите файл сюда или перенесите сохранённую работу через её меню «Название и папка»."
                  : "Отчёт, заметку или страницу из чата. Она останется на вашей полке вместе с новыми версиями, а ссылку вы включите сами."}
            </p>
            {query ? (
              <Button onClick={() => setQuery("")}>Сбросить поиск</Button>
            ) : (
              <>
                <div className="button-row">
                  <Button variant="primary" onClick={() => setPanel("upload")}>
                    <FileUp /> Загрузить файл
                  </Button>
                  <LinkButton href={bringHref}>
                    <LinkIcon /> Сохранить по ссылке
                  </LinkButton>
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
