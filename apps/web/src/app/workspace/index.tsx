import {AgentContextPanel} from "../../features/agent-context/index.tsx";
import { ShelfNavigation } from "../../widgets/shelf-navigation/index.tsx";
import { Button, Notice } from "../../shared/ui/controls.tsx";
import { CreateFolderPanel } from "../../features/create-folder/index.tsx";
import { ShelfPage } from "../../pages/shelf/index.tsx";
import { ArtifactReader } from "../../widgets/artifact-reader/index.tsx";
import { downloadRevision } from "../../features/download-artifact/index.ts";
import { AppShell } from "../../widgets/navigation/index.tsx";
import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, LogOut, Menu } from "lucide-react";
import type {
  Account,
  Artifact,
  Folder,
  Revision,
} from "../../../../../packages/contracts/index.ts";
import { ApiError, client } from "../../shared/api/client.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { Preview } from "../../widgets/artifact-preview/Preview.tsx";
import { UploadPanel } from "../../features/upload-artifact/index.tsx";
import { SharePanel } from "../../features/share-artifact/index.tsx";
import { ArtifactMetadataPanel } from "../../features/edit-artifact-metadata/index.tsx";
import { Login } from "../../pages/login/index.tsx";
import { NewLanding as Landing } from "../../pages/landing/index.tsx";
import { safeNext } from "../../shared/lib/safe-next.ts";
import { ReworkArtifactPanel } from "../../features/rework-artifact/index.tsx";
import { TrashArtifactPanel } from "../../features/trash-artifact/index.tsx";
import { TrashPanel } from "../../widgets/trash/index.tsx";
import "./styles.css";
const params = new URLSearchParams(location.search);
function resume(next: string) {
  const intent = params.get("intent");
  location.replace(
    intent && !/[?#]/.test(next)
      ? `${next}?intent=${encodeURIComponent(intent)}`
      : next,
  );
}
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
    [trashView, setTrashView] = useState(location.pathname === "/trash"),
    [work, setWork] = useState<Artifact | null>(null),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [viewed, setViewed] = useState<Revision | null>(null),
    [panel, setPanel] = useState<
      | "upload"
      | "version"
      | "share"
      | "folder"
      | "agent-context"
      | "rework"
      | "metadata"
      | "trash"
      | null
    >(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [loadingMore, setLoadingMore] = useState(false),
    [mobile, setMobile] = useState(false),
    [refresh, setRefresh] = useState(0),
    [history, setHistory] = useState(false),
    [notice, setNotice] = useState(""),
    [trashBusy, setTrashBusy] = useState(false),
    [trashActionError, setTrashActionError] = useState("");
  useEffect(() => setTrashActionError(""), [panel, selected]);
  const shelfGeneration = useRef(0);
  const trashGeneration = useRef(0);
  const routeGeneration = useRef(0);
  const selectedRef = useRef(selected);
  const accountRef = useRef(account);
  const trashBusyRef = useRef(false);
  selectedRef.current = selected;
  accountRef.current = account;
  const [trashItems, setTrashItems] = useState<Artifact[]>([]),
    [trashCursor, setTrashCursor] = useState<string | null>(null),
    [trashLoading, setTrashLoading] = useState(false),
    [trashError, setTrashError] = useState("");
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
    const pop = () => {
      routeGeneration.current++;
      trashGeneration.current++;
      const nextSelected = location.pathname.startsWith("/works/")
        ? location.pathname.split("/")[2]
        : null;
      selectedRef.current = nextSelected;
      setTrashView(location.pathname === "/trash");
      setSelected(nextSelected);
      setWork(null);
      setViewed(null);
      setPanel(null);
      setHistory(false);
      setLoading(false);
      setError("");
      trashBusyRef.current = false;
      setTrashBusy(false);
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const open = (id: string | null) => {
    shelfGeneration.current++;
    routeGeneration.current++;
    trashGeneration.current++;
    selectedRef.current = id;
    window.history.pushState(null, "", id ? `/works/${id}` : "/");
    setTrashView(false);
    setSelected(id);
    setWork(null);
    setViewed(null);
    setError("");
    setHistory(false);
    setPanel(null);
    trashBusyRef.current = false;
    setTrashBusy(false);
    setMobile(false);
  };
  const openTrash = () => {
    shelfGeneration.current++;
    routeGeneration.current++;
    trashGeneration.current++;
    selectedRef.current = null;
    window.history.pushState(null, "", "/trash");
    setTrashView(true);
    setSelected(null);
    setWork(null);
    setViewed(null);
    setError("");
    setLoading(false);
    setPanel(null);
    trashBusyRef.current = false;
    setTrashBusy(false);
    setMobile(false);
  };
  useEffect(
    () => () => {
      routeGeneration.current++;
      trashGeneration.current++;
    },
    [],
  );
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
    if (!account || selected || trashView) return;
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
  }, [account, selected, trashView, query, folderId, refresh]);
  const loadTrash = async (nextCursor?: string) => {
    const generation = trashGeneration.current;
    setTrashLoading(true);
    if (!nextCursor) setTrashError("");
    try {
      const page = await client.trash(nextCursor);
      if (generation !== trashGeneration.current) return;
      setTrashItems((current) =>
        nextCursor
          ? [
              ...current,
              ...page.items.filter(
                (a) => !current.some((old) => old.id === a.id),
              ),
            ]
          : page.items,
      );
      setTrashCursor(page.nextCursor);
    } catch (e) {
      if (generation === trashGeneration.current)
        setTrashError((e as Error).message);
    } finally {
      if (generation === trashGeneration.current) setTrashLoading(false);
    }
  };
  useEffect(() => {
    if (!account || !trashView) return;
    trashGeneration.current++;
    setTrashItems([]);
    setTrashCursor(null);
    void loadTrash();
  }, [account, trashView, refresh]);
  const refreshWork = async (): Promise<Artifact | null> => {
    if (!selected) return null;
    const expectedId = selected;
    const expectedAccount = account;
    const generation = routeGeneration.current;
    const [a, r] = await Promise.all([
      client.artifact(expectedId),
      client.revisions(expectedId),
    ]);
    if (
      routeGeneration.current !== generation ||
      selectedRef.current !== expectedId ||
      accountRef.current !== expectedAccount
    )
      return null;
    setWork(a);
    setRevisions(r);
    return a;
  };
  useEffect(() => {
    if (!account || !selected) return;
    const expectedId = selected;
    const expectedAccount = account;
    const generation = routeGeneration.current;
    let live = true;
    setLoading(true);
    Promise.all([client.artifact(selected), client.revisions(selected)])
      .then(([a, r]) => {
        if (
          live &&
          routeGeneration.current === generation &&
          selectedRef.current === expectedId &&
          accountRef.current === expectedAccount
        ) {
          setWork(a);
          setRevisions(r);
          const pinned=new URLSearchParams(location.search).get("revision");
          const exact=pinned?r.find(item=>item.id===pinned):null;
          if(pinned&&!exact){setWork(null);setError("Эта версия материала недоступна.");return;}
          setViewed(exact??null);
          setError("");
        }
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [account, selected, refresh]);
  const guestHome = location.pathname === "/" && !params.has("login");
  // The landing page is static: a guest (or an unreachable API) should still see it.
  if (guestHome && (account === null || authError)) return <Landing />;
  if (authError)
    return (
      <div className="empty">
        <h1>Не удалось соединиться с Полкой</h1>
        <ErrorNotice error={authError} />
        <Button onClick={() => location.reload()}>Попробовать снова</Button>
      </div>
    );
  if (account === undefined)
    return (
      <div className="empty" role="status">
        Открываем полку…
      </div>
    );
  if (!account)
    return (
      <Login
        onLogin={(a) => {
          const next = safeNext(params.get("next"));
          if (next && next !== "/") return resume(next);
          window.history.replaceState(null, "", location.pathname);
          setAccount(a);
        }}
      />
    );
  const nextAfterLogin = safeNext(params.get("next"));
  if (params.has("login") && nextAfterLogin && nextAfterLogin !== "/") {
    resume(nextAfterLogin);
    return (
      <div className="empty" role="status">
        Возвращаем к действию…
      </div>
    );
  }
  const activeFolder = folders.find((f) => f.id === folderId),
    shown = viewed ?? work?.revision;
  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const generation = shelfGeneration.current;
    setLoadingMore(true);
    try {
      const page = await client.shelf(query, folderId, cursor);
      if (generation !== shelfGeneration.current) return;
      setItems((x) => [
        ...x,
        ...page.items.filter((a) => !x.some((old) => old.id === a.id)),
      ]);
      setCursor(page.nextCursor);
    } catch (e) {
      if (generation === shelfGeneration.current)
        setError((e as Error).message);
    } finally {
      if (generation === shelfGeneration.current) setLoadingMore(false);
    }
  };
  const nav = (
    <ShelfNavigation
      folders={folders}
      folderId={folderId}
      trashView={trashView}
      onCreateFolder={() => {
        setPanel("folder");
        setMobile(false);
      }}
      onOpenFolder={(id) => {
        setFolderId(id);
        open(null);
      }}
      onOpenTrash={openTrash}
    />
  );

  return (
    <AppShell
      current="shelf"
      account={account}
      className={
        selected ? "app work-layout reader-layout" : "app shelf-layout"
      }
      navigation={<nav aria-label="Папки и корзина">{nav}</nav>}
      actions={<>
        <Button variant="quiet" className="navigation-mobile-menu" aria-label="Открыть папки и корзину" aria-haspopup="dialog" onClick={() => setMobile(true)}><Menu /></Button>
        <Button variant="quiet" aria-label="Выйти" title="Выйти"
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
        ><LogOut /></Button>
      </>}

    >
      <div className="workspace">
        {selected && <header className="topbar">
          <div className="top-start">
            <Button variant="quiet" className="icon" aria-label="Назад на полку" onClick={() => open(null)}><ArrowLeft /></Button>
            <span className="shelf-top-context">Моя Полка / Материал</span>
          </div>
        </header>}
        <main>
          {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
          <ErrorNotice error={error} />
          {selected ? (
            work && shown ? (
              <ArtifactReader
                work={work}
                shown={shown}
                revisions={revisions}
                viewed={viewed}
                folderName={
                  folders.find((f) => f.id === work.folderId)?.name ??
                  "Моя Полка"
                }
                history={history}
                setHistory={setHistory}
                setViewed={setViewed}
                setPanel={setPanel}
                onDownload={() => {
                  void downloadRevision(shown).catch((e) =>
                    setError(
                      e instanceof Error
                        ? e.message
                        : "Не удалось скачать материал.",
                    ),
                  );
                }}
                preview={
                  <Preview
                    revision={shown}
                    readingTitle={
                      shown.mime === "text/plain" ? work.title : undefined
                    }
                    onInlineBuildChange={async () => {
                      await refreshWork();
                    }}
                  />
                }
              />
            ) : loading ? (
              <div className="empty">Открываем работу…</div>
            ) : null
          ) : trashView ? (
            <TrashPanel
              items={trashItems}
              nextCursor={trashCursor}
              loading={trashLoading}
              error={trashError}
              onLoad={(nextCursor) => void loadTrash(nextCursor)}
              onRestore={async ({
                artifact,
                expectedLifecycleVersion,
                expectedRevisionId,
              }) => {
                const expectedGeneration = routeGeneration.current;
                const expectedAccount = account;
                await client.restoreArtifact(artifact.id, {
                  expectedLifecycleVersion,
                  expectedRevisionId,
                });
                if (
                  routeGeneration.current !== expectedGeneration ||
                  accountRef.current !== expectedAccount
                )
                  return;
                setNotice("Работа восстановлена. Старые ссылки закрыты.");
                setRefresh((value) => value + 1);
              }}
              onOpenArtifact={(artifact) => open(artifact.id)}
            />
          ) : (
            <ShelfPage
              activeFolder={activeFolder}
              folderId={folderId}
              folders={folders}
              items={items}
              query={query}
              view={view}
              loading={loading}
              loadingMore={loadingMore}
              cursor={cursor}
              setFolderId={setFolderId}
              setQuery={setQuery}
              setView={setView}
              setPanel={setPanel}
              open={open}
              loadMore={() => void loadMore()}
            />
          )}
        </main>
      </div>
      {mobile && (
        <Dialog title="Моя Полка" onClose={() => setMobile(false)}>
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
          onChange={async () => {
            await refreshWork();
          }}
        />
      )}{" "}
      {panel === "metadata" && work && (
        <ArtifactMetadataPanel
          artifact={work}
          folders={folders}
          onClose={() => setPanel(null)}
          onReload={refreshWork}
          onSaved={async () => {
            setPanel(null);
            setRefresh((x) => x + 1);
            await refreshWork();
          }}
        />
      )}
      {panel === "trash" && work && !work.trashedAt && (
        <TrashArtifactPanel
          busy={trashBusy}
          error={trashActionError}
          onClose={() => {
            if (!trashBusy) setPanel(null);
          }}
          onConfirm={async () => {
            if (trashBusyRef.current) return;
            const expectedId = work.id;
            const expectedAccount = account;
            const expectedGeneration = routeGeneration.current;
            const isCurrent = () =>
              routeGeneration.current === expectedGeneration &&
              selectedRef.current === expectedId &&
              accountRef.current === expectedAccount;
            setTrashActionError("");
            trashBusyRef.current = true;
            setTrashBusy(true);
            try {
              await client.trashArtifact(expectedId, {
                expectedLifecycleVersion: work.lifecycleVersion,
                expectedRevisionId: work.revision.id,
              });
              if (isCurrent()) {
                trashBusyRef.current = false;
                setTrashBusy(false);
                setPanel(null);
                setNotice(
                  "Работа перемещена в корзину. Старые ссылки закрыты.",
                );
                setRefresh((value) => value + 1);
                open(null);
              }
            } catch (e) {
              if (!isCurrent()) return;
              if (e instanceof ApiError && e.status === 409) {
                try {
                  await refreshWork();
                  if (isCurrent())
                    setTrashActionError(
                      "Работа изменилась. Данные обновлены, проверьте их и повторите перемещение.",
                    );
                } catch {
                  if (isCurrent())
                    setTrashActionError(
                      "Работа изменилась, но обновить данные не удалось. Обновите страницу и повторите действие.",
                    );
                }
              } else setTrashActionError((e as Error).message);
            } finally {
              if (isCurrent()) {
                trashBusyRef.current = false;
                setTrashBusy(false);
              }
            }
          }}
        />
      )}
      {panel === "agent-context" && work && shown && <AgentContextPanel key={shown.id} artifactId={work.id} revisionId={shown.id} onClose={()=>setPanel(null)}/>}
      {panel === "rework" && work && (
        <ReworkArtifactPanel
          title={work.title}
          onClose={() => setPanel(null)}
          onUpload={() => setPanel("version")}
        />
      )}
      {panel === "folder" && (
        <CreateFolderPanel
          onClose={() => setPanel(null)}
          onCreated={(folder) => {
            setPanel(null);
            setRefresh((x) => x + 1);
            setFolderId(folder.id);
            open(null);
          }}
        />
      )}
    </AppShell>
  );
}
