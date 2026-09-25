import { AgentContextPanel } from "../../features/agent-context/index.tsx";
import { ShelfNavigation } from "../../widgets/shelf-navigation/index.tsx";
import { Button, IconButton, Notice } from "../../shared/ui/controls.tsx";
import { CreateFolderPanel } from "../../features/create-folder/index.tsx";
import { ShelfPage, type CardAction, type ShelfSort } from "../../pages/shelf/index.tsx";
import {
  ArtifactReader,
  readerTabFromSearch,
  withReaderTab,
} from "../../widgets/artifact-reader/index.tsx";
import { downloadRevision } from "../../features/download-artifact/index.ts";
import { CompareRevisions } from "../../features/compare-revisions/index.tsx";
import { AppShell } from "../../widgets/navigation/index.tsx";
import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft, Menu } from "lucide-react";
import { useWorkComments } from "../../widgets/comments/index.ts";
import type {
  Artifact,
  Folder,
  Revision,
} from "../../../../../packages/contracts/index.ts";
import { ApiError, client, withShelf } from "../../shared/api/client.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { Preview } from "../../widgets/artifact-preview/Preview.tsx";
import { UploadPanel } from "../../features/upload-artifact/index.tsx";
import { SharePanel } from "../../features/share-artifact/index.tsx";
import { ArtifactMetadataPanel } from "../../features/edit-artifact-metadata/index.tsx";
import { Login } from "../../pages/login/index.tsx";
import {
  rememberAccount,
  useAccountState,
} from "../../entities/account/model/useAccount.ts";
import { LazyLanding } from "../routing/lazy-pages.tsx";
import { safeNext } from "../../shared/lib/safe-next.ts";
import { ReworkArtifactPanel } from "../../features/rework-artifact/index.tsx";
import { shelfUrl } from "../../entities/artifact/agent-phrases.ts";
import { TrashArtifactPanel } from "../../features/trash-artifact/index.tsx";
import { TrashPanel } from "../../widgets/trash/index.tsx";
import { useDocumentTitle } from "../../shared/lib/document-title.ts";
import { useShelves, shelfName } from "../../entities/shelf/model.ts";
import {
  CreateShelfPanel,
  ShelfMembersPanel,
  ShelfSwitcher,
} from "../../features/shelf-members/index.tsx";
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
  const { account, error: authError, retry: retryAccount } = useAccountState();
  // Department shelves (docs/specs/TEAM_SHELVES.md): which shelf this tab shows.
  const shelves = useShelves(!!account && !account.provisional);
  const team = shelves.current?.kind === "team" ? shelves.current : null;
  const [shelfDialog, setShelfDialog] = useState<"create" | "members" | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]),
    [folderId, setFolderId] = useState<string | null>(null),
    [items, setItems] = useState<Artifact[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [query, setQuery] = useState(() => params.get("q") ?? ""),
    [view, setView] = useState<"grid" | "list">("grid"),
    [sort, setSort] = useState<ShelfSort>("newest"),
    [focusSearch] = useState(() => params.has("search")),
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
    >(() => {
      // Deep links (and the shelf card menu) may open a work with its dialog.
      const requested = params.get("panel");
      return location.pathname.startsWith("/works/") &&
        (requested === "share" || requested === "metadata" || requested === "agent-context")
        ? requested
        : null;
    }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [loadingMore, setLoadingMore] = useState(false),
    [mobile, setMobile] = useState(false),
    [refresh, setRefresh] = useState(0),
    // «Версии» survives a reload: /works/:id?tab=versions.
    [history, setHistoryState] = useState(
      () =>
        location.pathname.startsWith("/works/") &&
        readerTabFromSearch(location.search) === "versions",
    ),
    [notice, setNotice] = useState(""),
    [trashBusy, setTrashBusy] = useState(false),
    [trashActionError, setTrashActionError] = useState("");
  const stageRef = useRef<HTMLElement>(null);
  // The reader's tab lives in the address too (replaced, not pushed).
  const setHistory = (value: boolean) => {
    setHistoryState(value);
    if (location.pathname.startsWith("/works/"))
      window.history.replaceState(
        window.history.state,
        "",
        withReaderTab(location.href, value ? "versions" : "work"),
      );
  };
  // The tab names the open work (the owner's own title) or the trash.
  useDocumentTitle(selected ? (work?.title ?? "Работа") : trashView ? "Корзина" : null);
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
      setHistoryState(
        !!nextSelected && readerTabFromSearch(location.search) === "versions",
      );
      setLoading(false);
      setError("");
      trashBusyRef.current = false;
      setTrashBusy(false);
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const open = (id: string | null, nextPanel: CardAction | null = null) => {
    shelfGeneration.current++;
    routeGeneration.current++;
    trashGeneration.current++;
    selectedRef.current = id;
    window.history.pushState(null, "", withShelf(id ? `/works/${id}` : "/"));
    setTrashView(false);
    setSelected(id);
    setWork(null);
    setViewed(null);
    setError("");
    setHistoryState(false);
    setPanel(nextPanel);
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
          const pinned = new URLSearchParams(location.search).get("revision");
          const exact = pinned ? r.find((item) => item.id === pinned) : null;
          if (pinned && !exact) {
            setWork(null);
            setError("Эта версия работы недоступна.");
            return;
          }
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
  // Comments of the work's links (docs/specs/COMMENTS.md): only once a link
  // was ever made, never in the trash.
  const workComments = useWorkComments({
    artifactId: work?.id ?? "",
    title: work?.title ?? "",
    shelfUrl: work ? shelfUrl(location.origin, work.id) : "",
    enabled: !!selected && !!work && !work.trashedAt && !!work.share,
  });
  if (guestHome && (account === null || authError)) return <LazyLanding />;
  if (authError)
    return (
      <div className="empty">
        <h1>Не удалось соединиться с Полкой</h1>
        <ErrorNotice error={authError} />
        <Button onClick={retryAccount}>Попробовать снова</Button>
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
          rememberAccount(a);
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
    <>
    <ShelfSwitcher
      shelves={shelves.items}
      current={shelves.current}
      canCreate={shelves.canCreate}
      onCreate={() => {
        setShelfDialog("create");
        setMobile(false);
      }}
      onMembers={() => {
        setShelfDialog("members");
        setMobile(false);
      }}
    />
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
    </>
  );

  const notices = (
    <>
      {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
      <ErrorNotice error={error} />
    </>
  );

  return (
    <AppShell
      current="shelf"
      account={account}
      foldableRail={!!selected}
      className={
        selected ? "app work-layout reader-layout" : "app shelf-layout"
      }
      navigation={<nav aria-label="Папки и корзина">{nav}</nav>}
      actions={
        <IconButton className="navigation-mobile-menu" label="Папки и корзина" aria-haspopup="dialog" onClick={() => setMobile(true)}>
          <Menu />
        </IconButton>
      }
      onLoggedOut={() => {
        setItems([]);
        setFolders([]);
        setFolderId(null);
        setWork(null);
        open(null);
      }}
    >
      <div
        className="workspace"
        data-comments={
          workComments.available && workComments.open ? "open" : undefined
        }
      >
        <main>
          {!selected && notices}
          {selected ? (
            work && shown ? (
              <ArtifactReader
                work={work}
                shelfUrl={shelfUrl(location.origin, work.id)}
                shown={shown}
                revisions={revisions}
                viewed={viewed}
                folderName={
                  folders.find((f) => f.id === work.folderId)?.name ??
                  shelfName(shelves.current)
                }
                history={history}
                setHistory={setHistory}
                setViewed={setViewed}
                setPanel={setPanel}
                notices={notices}
                onBack={() => open(null)}
                stageRef={stageRef}
                onFullscreen={() => {
                  // The stage is hidden under «Версии»: show it first.
                  if (history) flushSync(() => setHistory(false));
                  void stageRef.current?.requestFullscreen?.();
                }}
                comments={
                  workComments.available
                    ? {
                        label: workComments.label,
                        count: workComments.count,
                        unread: workComments.unread,
                        open: workComments.open,
                        onToggle: workComments.onToggle,
                      }
                    : undefined
                }
                compare={
                  history ? (
                    <CompareRevisions revisions={revisions} shown={shown} />
                  ) : null
                }
                onDownload={() => {
                  void downloadRevision(shown, work.title).catch((e) =>
                    setError(
                      e instanceof Error
                        ? e.message
                        : "Не удалось скачать работу.",
                    ),
                  );
                }}
                preview={
                  <Preview
                    revision={shown}
                    title={work.title}
                    overlay={
                      workComments.available ? workComments.overlay : undefined
                    }
                    readingTitle={
                      shown.mime === "text/plain" ? work.title : undefined
                    }
                    onInlineBuildChange={async () => {
                      await refreshWork();
                    }}
                  />
                }
              />
            ) : (
              <div className="work-reader">
                <header className="work-bar">
                  <div className="work-bar-lead">
                    <IconButton label="Назад на полку" size="sm" onClick={() => open(null)}>
                      <ArrowLeft />
                    </IconButton>
                    <span className="work-bar-title">Работа</span>
                  </div>
                </header>
                {notices}
                {loading && (
                  <div className="empty" role="status">Открываем работу…</div>
                )}
              </div>
            )
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
              account={account}
              activeFolder={activeFolder}
              items={items}
              query={query}
              view={view}
              sort={sort}
              loading={loading}
              loadingMore={loadingMore}
              cursor={cursor}
              focusSearch={focusSearch}
              setQuery={setQuery}
              setView={setView}
              setSort={setSort}
              setPanel={setPanel}
              open={open}
              loadMore={() => void loadMore()}
              team={team}
            />
          )}
        </main>
      </div>
      {selected && workComments.available && workComments.open && (
        <aside id="work-comments" className="work-comments" aria-label={workComments.label}>
          {workComments.panel}
        </aside>
      )}
      {selected && workComments.floating}
      {mobile && (
        <Dialog title="Папки" onClose={() => setMobile(false)}>
          <nav className="mobile-nav" aria-label="Папки и корзина (меню)">{nav}</nav>
        </Dialog>
      )}
      {shelfDialog === "create" && <CreateShelfPanel onClose={() => setShelfDialog(null)} />}
      {shelfDialog === "members" && team && account && (
        <ShelfMembersPanel shelf={team} accountId={account.id} onClose={() => setShelfDialog(null)} />
      )}
      {(panel === "upload" || panel === "version") && (
        <UploadPanel
          artifact={panel === "version" ? (work ?? undefined) : undefined}
          shelfUrl={panel === "version" && work ? shelfUrl(location.origin, work.id) : undefined}
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
          provisional={!!account?.provisional}
          onClose={() => setPanel(null)}
          onChange={async () => {
            await refreshWork();
          }}
        />
      )}
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
      {panel === "agent-context" && work && shown && (
        <AgentContextPanel
          key={shown.id}
          artifactId={work.id}
          revisionId={shown.id}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "rework" && work && (
        <ReworkArtifactPanel
          title={work.title}
          shelfUrl={shelfUrl(location.origin, work.id)}
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
