import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Folder as FolderIcon,
  Image as ImageIcon,
  Link as LinkIcon,
  LockKeyhole,
  LogOut,
  Menu,
  Plus,
  Search,
  Upload,
  X,
  Grid2X2,
  List,
  Clock3,
  Download,
  Check,
} from "lucide-react";
import type {
  Account,
  Artifact,
  Folder,
  Revision,
} from "../../../packages/contracts/index.ts";
import { ApiError, bytes, client } from "./client.ts";
import { date, size, status, isImage } from "./format.ts";
import { Brand, Dialog, ErrorNotice } from "./ui.tsx";
import { Preview } from "./Preview.tsx";
import { UploadPanel } from "./UploadPanel.tsx";
import { SharePanel } from "./SharePanel.tsx";
import { Login } from "./Login.tsx";
export function App() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined),
    [authError, setAuthError] = useState(""),
    [folders, setFolders] = useState<Folder[]>([]),
    [folderId, setFolderId] = useState<string | null>(null),
    [items, setItems] = useState<Artifact[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [view, setView] = useState<"grid" | "list">("grid"),
    [selected, setSelected] = useState<string | null>(
      location.pathname.startsWith("/works/")
        ? location.pathname.split("/")[2]
        : null,
    ),
    [work, setWork] = useState<Artifact | null>(null),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [viewed, setViewed] = useState<Revision | null>(null),
    [panel, setPanel] = useState<
      "upload" | "version" | "share" | "folder" | null
    >(null),
    [folderName, setFolderName] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [loadingMore, setLoadingMore] = useState(false),
    [mobile, setMobile] = useState(false),
    [refresh, setRefresh] = useState(0),
    [history, setHistory] = useState(false),
    [notice, setNotice] = useState("");
  const shelfGeneration = useRef(0);
  useEffect(() => {
    client
      .me()
      .then(setAccount)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setAccount(null);
        else setAuthError(e.message);
      });
  }, []);
  useEffect(() => {
    const pop = () =>
      setSelected(
        location.pathname.startsWith("/works/")
          ? location.pathname.split("/")[2]
          : null,
      );
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const open = (id: string | null) => {
    shelfGeneration.current++;
    window.history.pushState(null, "", id ? `/works/${id}` : "/");
    setSelected(id);
    setWork(null);
    setViewed(null);
    setError("");
    setHistory(false);
    setMobile(false);
  };
  useEffect(() => {
    let live = true;
    setFolders([]);
    if (account)
      client
        .folders()
        .then((x) => {
          if (live) setFolders(x);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [account, refresh]);
  useEffect(() => {
    shelfGeneration.current++;
    setLoadingMore(false);
    if (!account || selected) return;
    let live = true;
    setLoading(true);
    const timer = setTimeout(
      () =>
        client
          .shelf(query, folderId)
          .then((x) => {
            if (live) {
              setItems(x.items);
              setCursor(x.nextCursor);
              setError("");
            }
          })
          .catch((e) => live && setError(e.message))
          .finally(() => live && setLoading(false)),
      150,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [account, selected, query, folderId, refresh]);
  const refreshWork = async () => {
    if (!selected) return;
    const [a, r] = await Promise.all([
      client.artifact(selected),
      client.revisions(selected),
    ]);
    setWork(a);
    setRevisions(r);
  };
  useEffect(() => {
    if (!account || !selected) return;
    let live = true;
    setLoading(true);
    Promise.all([client.artifact(selected), client.revisions(selected)])
      .then(([a, r]) => {
        if (live) {
          setWork(a);
          setRevisions(r);
          setViewed(null);
          setError("");
        }
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [account, selected, refresh]);
  if (authError)
    return (
      <div className="empty">
        <h1>Не удалось соединиться с Полкой</h1>
        <ErrorNotice error={authError} />
        <button onClick={() => location.reload()}>Попробовать снова</button>
      </div>
    );
  if (account === undefined)
    return (
      <div className="empty" role="status">
        Открываем полку…
      </div>
    );
  if (!account) return <Login onLogin={setAccount} />;
  const activeFolder = folders.find((f) => f.id === folderId),
    shown = viewed ?? work?.revision;
  const nav = (
    <>
      <a
        className={!folderId ? "nav-link active" : "nav-link"}
        href="/"
        onClick={(e) => {
          e.preventDefault();
          setFolderId(null);
          open(null);
        }}
      >
        <Grid2X2 />
        Моя полка
      </a>
      <div className="nav-label">
        ПАПКИ
        <button
          className="icon small"
          aria-label="Создать папку"
          onClick={() => {
            setPanel("folder");
            setMobile(false);
          }}
        >
          <Plus />
        </button>
      </div>
      {folders.map((f) => (
        <a
          href="/"
          key={f.id}
          className={folderId === f.id ? "nav-link active" : "nav-link"}
          onClick={(e) => {
            e.preventDefault();
            setFolderId(f.id);
            open(null);
          }}
        >
          <FolderIcon />
          {f.name}
        </a>
      ))}
      <div className="nav-bottom">
        <span className="dot" />
        Файлы сохраняются на этом сервере
        <small>Локальная сборка · первый рабочий срез</small>
      </div>
    </>
  );
  return (
    <div className={selected ? "app work-layout" : "app"}>
      <aside>
        <Brand />
        <nav>{nav}</nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="top-start">
            {selected ? (
              <button
                className="icon"
                aria-label="Назад на полку"
                onClick={() => open(null)}
              >
                <ArrowLeft />
              </button>
            ) : (
              <button
                className="icon mobile-menu"
                aria-label="Открыть навигацию"
                onClick={() => setMobile(true)}
              >
                <Menu />
              </button>
            )}
            {selected ? (
              <Brand />
            ) : (
              <span className="muted">Личное пространство</span>
            )}
          </div>
          <div className="account">
            <span className="avatar">
              {account.name.slice(0, 1).toUpperCase()}
            </span>
            <span>{account.name}</span>
            <button
              className="icon"
              aria-label="Выйти"
              onClick={async () => {
                try {
                  await client.logout();
                  setAccount(null);
                  setItems([]);
                  setFolders([]);
                  setFolderId(null);
                  setWork(null);
                  open(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <LogOut />
            </button>
          </div>
        </header>
        <main>
          {notice && (
            <div className="notice" role="status">
              {notice}
              <button
                className="icon small"
                aria-label="Скрыть уведомление"
                onClick={() => setNotice("")}
              >
                <X />
              </button>
            </div>
          )}
          <ErrorNotice error={error} />
          {selected ? (
            work && shown ? (
              <>
                <div className="work-heading">
                  <div>
                    <span className="breadcrumb">
                      {folders.find((f) => f.id === work.folderId)?.name ??
                        "Моя полка"}
                      <ChevronRight />
                      Работа
                    </span>
                    <h1>{work.title}</h1>
                    <div className="meta">
                      <span className="pill">
                        <LockKeyhole />
                        {status(work)}
                      </span>
                      <span>Сохранено · v{work.revision.number}</span>
                    </div>
                  </div>
                  <div className="button-row">
                    <button onClick={() => setPanel("version")}>
                      <Upload />
                      Новая версия
                    </button>
                    <button
                      className="primary"
                      onClick={() => setPanel("share")}
                    >
                      <LinkIcon />
                      Поделиться
                    </button>
                  </div>
                </div>
                <div className="work-toolbar">
                  <div className="button-row">
                    <button
                      className={
                        !history ? "text-button active" : "text-button"
                      }
                      onClick={() => setHistory(false)}
                    >
                      Материал
                    </button>
                    <button
                      className={history ? "text-button active" : "text-button"}
                      onClick={() => setHistory(!history)}
                    >
                      <Clock3 />
                      Версии <span>{revisions.length}</span>
                    </button>
                  </div>
                  <span className="muted">
                    {shown.mime === "text/plain" ? "Текст" : "Изображение"} ·{" "}
                    {size(shown.size)}
                  </span>
                </div>
                {history && (
                  <div className="versions">
                    {revisions.map((r) => (
                      <button
                        key={r.id}
                        className={shown.id === r.id ? "selected" : ""}
                        onClick={() => setViewed(r)}
                      >
                        <span>
                          Версия {r.number}
                          {work.share?.revisionId === r.id &&
                            ["active", "behind"].includes(
                              work.share.status,
                            ) && <small>по ссылке</small>}
                        </span>
                        <small>{date(r.createdAt)}</small>
                        {shown.id === r.id && <Check />}
                      </button>
                    ))}
                  </div>
                )}
                {viewed && viewed.id !== work.revision.id && (
                  <p className="history-note">
                    Вы смотрите версию {viewed.number}. Новые сохранения и
                    ссылка не изменяются.
                    <button
                      className="text-button"
                      onClick={() => setViewed(null)}
                    >
                      К текущей версии
                    </button>
                  </p>
                )}
                <section className="stage">
                  <Preview revision={shown} />
                </section>
                <div className="work-foot">
                  <span>{shown.filename}</span>
                  <button
                    className="text-button"
                    onClick={async () => {
                      try {
                        const blob = await bytes(
                          `/revisions/${shown.id}/bytes`,
                        );
                        const url = URL.createObjectURL(blob),
                          a = document.createElement("a");
                        a.href = url;
                        a.download = shown.filename;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <Download />
                    Скачать оригинал
                  </button>
                </div>
              </>
            ) : loading ? (
              <div className="empty">Открываем работу…</div>
            ) : null
          ) : (
            <>
              <div className="shelf-heading">
                <div>
                  <span className="eyebrow">ВАШИ МАТЕРИАЛЫ, В ОДНОМ МЕСТЕ</span>
                  <h1>{activeFolder?.name ?? "Моя полка"}</h1>
                  <p className="muted">
                    Сохраняйте хорошие работы. Возвращайтесь к ним. Делитесь.
                  </p>
                </div>
                <button className="primary" onClick={() => setPanel("upload")}>
                  <Plus />
                  Добавить работу
                </button>
              </div>
              <div className="shelf-tools">
                <label className="search">
                  <Search />
                  <input
                    aria-label="Найти работу"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Найти на полке…"
                  />
                  {query && (
                    <button
                      className="icon small"
                      aria-label="Очистить поиск"
                      onClick={() => setQuery("")}
                    >
                      <X />
                    </button>
                  )}
                </label>
                <div className="segmented compact">
                  <button
                    aria-label="Карточки"
                    aria-pressed={view === "grid"}
                    onClick={() => setView("grid")}
                  >
                    <Grid2X2 />
                  </button>
                  <button
                    aria-label="Список"
                    aria-pressed={view === "list"}
                    onClick={() => setView("list")}
                  >
                    <List />
                  </button>
                </div>
              </div>
              {!folderId && folders.length > 0 && (
                <div className="folder-chips">
                  {folders.map((f) => (
                    <button key={f.id} onClick={() => setFolderId(f.id)}>
                      <FolderIcon />
                      {f.name}
                      <ChevronRight />
                    </button>
                  ))}
                </div>
              )}
              {loading ? (
                <div className="empty" role="status">
                  Загружаем работы…
                </div>
              ) : items.length ? (
                <>
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
                              {isImage(a.revision) ? "Изображение" : "Текст"} ·
                              v{a.revision.number}
                            </span>
                            <span className="card-date">
                              {date(a.updatedAt)}
                            </span>
                          </p>
                        </div>
                        <span className="card-access">
                          {a.share &&
                          ["active", "behind"].includes(a.share.status) ? (
                            <LinkIcon />
                          ) : (
                            <LockKeyhole />
                          )}
                          <span>{status(a)}</span>
                        </span>
                      </a>
                    ))}
                    {view === "grid" && (
                      <button
                        className="add-card"
                        onClick={() => setPanel("upload")}
                      >
                        <span>
                          <Plus />
                        </span>
                        <strong>Ещё одна хорошая работа</strong>
                        <small>Добавьте файл или текст</small>
                      </button>
                    )}
                  </div>
                  {cursor && (
                    <button
                      className="load-more"
                      disabled={loadingMore}
                      onClick={async () => {
                        const generation = shelfGeneration.current;
                        setLoadingMore(true);
                        try {
                          const page = await client.shelf(
                            query,
                            folderId,
                            cursor,
                          );
                          if (generation !== shelfGeneration.current) return;
                          setItems((x) => [
                            ...x,
                            ...page.items.filter(
                              (a) => !x.some((old) => old.id === a.id),
                            ),
                          ]);
                          setCursor(page.nextCursor);
                        } catch (e) {
                          if (generation === shelfGeneration.current)
                            setError((e as Error).message);
                        } finally {
                          if (generation === shelfGeneration.current)
                            setLoadingMore(false);
                        }
                      }}
                    >
                      Показать ещё
                    </button>
                  )}
                </>
              ) : (
                <div className="empty">
                  <div className="empty-icon">
                    {query ? <Search /> : <FolderIcon />}
                  </div>
                  <h2>
                    {query
                      ? "Пока ничего не нашли"
                      : "Здесь будут ваши хорошие работы"}
                  </h2>
                  <p>
                    {query
                      ? "Попробуйте другое название."
                      : "Добавьте первый материал — он останется на полке после закрытия вкладки."}
                  </p>
                  {!query && (
                    <button
                      className="primary"
                      onClick={() => setPanel("upload")}
                    >
                      <Plus />
                      Добавить первую работу
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {mobile && (
        <Dialog title="Моя полка" onClose={() => setMobile(false)}>
          <nav className="mobile-nav">{nav}</nav>
        </Dialog>
      )}
      {(panel === "upload" || panel === "version") && (
        <UploadPanel
          artifact={panel === "version" ? (work ?? undefined) : undefined}
          folders={folders}
          folderId={folderId}
          onClose={() => setPanel(null)}
          onSaved={(r) => {
            setPanel(null);
            setRefresh((x) => x + 1);
            open(r.artifactId);
            setNotice(
              `Версия ${r.number} сохранена. ${r.number > 1 ? "Отправленная ссылка не изменилась." : "Пока работу видите только вы."}`,
            );
          }}
        />
      )}
      {panel === "share" && work && (
        <SharePanel
          artifact={work}
          onClose={() => setPanel(null)}
          onChange={refreshWork}
        />
      )}{" "}
      {panel === "folder" && (
        <Dialog title="Новая папка" onClose={() => setPanel(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const f = await client.createFolder(folderName);
                setFolderName("");
                setPanel(null);
                setRefresh((x) => x + 1);
                setFolderId(f.id);
                open(null);
              } catch (e) {
                setError((e as Error).message);
                setPanel(null);
              }
            }}
          >
            <div className="dialog-body">
              <label>
                Название папки
                <input
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  required
                  maxLength={80}
                  autoFocus
                />
              </label>
            </div>
            <div className="dialog-footer">
              <button type="button" onClick={() => setPanel(null)}>
                Отмена
              </button>
              <button className="primary">Создать папку</button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
