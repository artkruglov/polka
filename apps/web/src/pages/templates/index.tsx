import React, { useEffect, useState } from "react";
import { ArrowUpRight, Eye, FileCode2, Search, Sparkles, Upload } from "lucide-react";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { request, savedWorkHref } from "../../shared/api/client.ts";
import { Button, LinkButton, EmptyState, Badge, Segmented } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { TextCover } from "../../widgets/artifact-preview/index.ts";
import { AgentContextPanel } from "../../features/agent-context/index.tsx";
import { CreateLibrary, TemplateLibraryManagement } from "../../features/template-library-management/index.tsx";
import { TemplateLibraryPreview } from "../../features/template-library-preview/index.tsx";
import "./styles.css";
type Template = {
  releaseId: string;
  artifactId: string;
  revisionId: string;
  title: string;
  summary: string;
  revisionNumber: number;
  isLatest: boolean;
  mime?: string;
  libraryId?: string;
  publicationId?: string;
};
type TemplateLibrary = { id: string; name: string; role: "reader" | "curator" | "admin" };
type LibraryPreviewTemplate = Template & { libraryId: string; publicationId: string };

function formatLabel(mime: string | undefined) {
  switch (mime) {
    case "text/html": return "HTML";
    case "text/plain": return "Текст";
    case "image/png": return "PNG";
    case "image/jpeg": return "JPEG";
    case "image/webp": return "WebP";
    default: return "Неизвестный формат";
  }
}

function isHtmlTemplate(template: Pick<Template, "mime">) {
  return template.mime === "text/html";
}
export function Templates() {
  const account = useAccount(),
    [items, setItems] = useState<Template[]>([]),
    [selected, setSelected] = useState<Template | null>(null),
    [preview, setPreview] = useState<LibraryPreviewTemplate | null>(null),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [attempt, setAttempt] = useState(0),
    [draftQuery, setDraftQuery] = useState(""),
    [query, setQuery] = useState(""),
    [includePrevious, setIncludePrevious] = useState(false),
    [hasMore, setHasMore] = useState(false),
    [libraries, setLibraries] = useState<TemplateLibrary[]>([]),
    [libraryId, setLibraryId] = useState(() => new URLSearchParams(location.search).get("libraryId") || ""),
    [librariesLoading, setLibrariesLoading] = useState(false),
    [libraryError, setLibraryError] = useState(""),
    [libraryAttempt, setLibraryAttempt] = useState(0);
  const [personalReleases, setPersonalReleases] = useState<Template[]>([]), [personalError, setPersonalError] = useState(""), [personalAttempt, setPersonalAttempt] = useState(0);
  useEffect(() => {
    if (!account) {
      setLibraries([]);
      setLibraryId("");
      return;
    }
    let live = true;
    setLibrariesLoading(true);
    setLibraryError("");
    request<{ items: TemplateLibrary[] }>("/template-libraries")
      .then((result) => {
        if (!live) return;
        setLibraries(result.items);
        const requested = new URLSearchParams(location.search).get("libraryId") || "";
        setLibraryId(requested);
        if (requested && !result.items.some((item) => item.id === requested))
          setLibraryError("Эта библиотека недоступна вашему аккаунту.");
      })
      .catch((e) => {
        if (live) {
          setLibraries([]);
          setLibraryId("");
          setLibraryError(e instanceof Error ? e.message : "Не удалось загрузить библиотеки.");
        }
      })
      .finally(() => live && setLibrariesLoading(false));
    return () => { live = false; };
  }, [account?.id, libraryAttempt]);
  useEffect(() => {
    let live = true;
    setItems([]);
    setLoaded(false);
    setError("");
    setSelected(null);
    setPreview(null);
    setHasMore(false);
    const validLibrary = !libraryId || libraries.some((library) => library.id === libraryId);
    if (account && validLibrary && !libraryError)
      request<{ items: Template[]; hasMore: boolean }>(`/templates?${new URLSearchParams({ query, includePrevious: String(includePrevious), ...(libraryId ? { libraryId } : {}) })}`)
        .then((x) => {
          if (live) {
            setItems(x.items);
            setHasMore(x.hasMore);
            setLoaded(true);
          }
        })
        .catch((e) => {
          if (live) setError(e instanceof Error ? e.message : "Не удалось загрузить шаблоны.");
        });
    return () => {
      live = false;
    };
  }, [account?.id, attempt, query, includePrevious, libraryId, libraries, libraryError]);
  useEffect(() => {
    setPersonalReleases([]);
    setPersonalError("");
    if (!account || !libraryId) {
      return;
    }
    let live = true;
    request<{ items: Template[] }>("/templates?" + new URLSearchParams({ includePrevious: "true" }))
      .then((result) => live && setPersonalReleases(result.items))
      .catch((e) => live && setPersonalError(e instanceof Error ? e.message : "Не удалось загрузить личные выпуски."));
    return () => { live = false; };
  }, [account?.id, libraryId, personalAttempt]);
  function selectLibrary(value: string) {
    setLibraryId(value);
    setItems([]); setSelected(null); setPreview(null); setLoaded(false); setError(""); setLibraryError(""); setHasMore(false);
    const params = new URLSearchParams(location.search);
    if (value) params.set("libraryId", value); else params.delete("libraryId");
    const search = params.toString();
    history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}`);
  }
  function openPreview(template: Template) {
    if (isHtmlTemplate(template) && template.libraryId && template.publicationId)
      setPreview(template as LibraryPreviewTemplate);
  }
  const selectedLibrary = libraries.find((library) => library.id === libraryId);
  const scopes = [{ id: "", label: "Мои" }, ...libraries.map((library) => ({ id: library.id, label: library.name }))];
  return (
    <AppShell current="templates" account={account} className="templates-page">
      <main className="templates-main">
        <header className="templates-heading">
          <div>
            <h1>{selectedLibrary?.name || "Шаблоны"}</h1>
            <p>Примеры и правила для вашего агента.</p>
          </div>
          {account && (
            <LinkButton href="/" className="templates-from-work">
              <Upload /> Из работы в шаблон
            </LinkButton>
          )}
        </header>
        {account && (
          <form className="templates-toolbar" onSubmit={(event) => {
            event.preventDefault(); setQuery(draftQuery.trim());
          }}>
            <label className="ui-search templates-search">
              <Search aria-hidden="true" />
              <input type="search" aria-label="Найти шаблон" value={draftQuery}
                onChange={(event) => setDraftQuery(event.target.value)} maxLength={200}
                placeholder="Найти шаблон" />
            </label>
            {(librariesLoading || libraries.length > 0) && (
              <Segmented label="Каталог шаблонов" value={libraryId} onChange={selectLibrary} options={scopes} wide />
            )}
            <label className="templates-history">
              <input type="checkbox" checked={includePrevious}
                onChange={(event) => setIncludePrevious(event.target.checked)} />
              Предыдущие выпуски
            </label>
            <button type="submit" className="sr-only">Найти</button>
          </form>
        )}
        {account && (
          <div className="templates-libraries">
            <CreateLibrary key={account.id} accountId={account.id} onCreated={(library) => {
              setLibraries((current) => [library, ...current]);
              selectLibrary(library.id);
            }} />
            <span className="fine">Общая библиотека показывает опубликованные версии, доступные вашей команде. По умолчанию — последний закреплённый выпуск каждого шаблона.</span>
          </div>
        )}
        {account && selectedLibrary && <TemplateLibraryManagement
          key={`${account.id}:${selectedLibrary.id}`}
          library={selectedLibrary}
          account={account}
          personalReleases={personalReleases}
          onRefreshCatalog={() => setAttempt((value) => value + 1)}
          onRefreshLibraries={() => setLibraryAttempt((value) => value + 1)}
        />}
        {account && selectedLibrary && personalError && <div><ErrorNotice error={personalError} /><Button onClick={() => setPersonalAttempt((value) => value + 1)}>Повторить загрузку личных выпусков</Button></div>}
        {account === null ? (
          <EmptyState title="Шаблоны живут на вашей полке" action={<LinkButton variant="primary" href="/?login=1&next=%2Ftemplates">Войти в Полку</LinkButton>}>
            Оформление, структура и правила — для следующей задачи в вашем агенте.
          </EmptyState>
        ) : libraryError ? (
          <div><ErrorNotice error={libraryError} /><Button onClick={() => setLibraryAttempt((value) => value + 1)}>Повторить загрузку библиотек</Button></div>
        ) : error ? (
          <div>
            <ErrorNotice error={error} />
            <Button onClick={() => { setError(""); setLoaded(false); setAttempt((value) => value + 1); }}>
              Повторить загрузку
            </Button>
          </div>
        ) : !loaded ? (
          <div className="templates-grid" role="status" aria-label="Загружаем шаблоны…">
            {[0, 1, 2].map((i) => <div key={i} className="template-card"><div className="template-cover placeholder" /></div>)}
          </div>
        ) : items.length === 0 && query ? (
          <EmptyState title="Подходящих шаблонов не найдено" action={<Button onClick={() => {
            setDraftQuery(""); setQuery("");
          }}>Сбросить поиск</Button>}>
            Попробуйте название работы или её назначение. Для старых выпусков включите показ предыдущих версий.
          </EmptyState>
        ) : items.length === 0 && libraryId ? (
          <EmptyState title="В библиотеке пока нет опубликованных шаблонов">
            Здесь появятся версии, которые опубликует администратор или куратор библиотеки.
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState
            title="Сохраните первый шаблон"
            action={<LinkButton variant="primary" href="/"><Sparkles /> Открыть мою полку</LinkButton>}
          >
            Откройте работу → «Скопировать для агента» → «Сохранить эту версию
            как шаблон». Исходники и правила останутся вместе.
          </EmptyState>
        ) : (
          <div className="templates-grid">
            {items.map((t) => (
              <article className="template-card" key={t.releaseId} data-selected={selected?.releaseId === t.releaseId || undefined}>
                <button type="button" className="template-cover" onClick={() => setSelected(t)} aria-label={`Открыть контекст: ${t.title}`}>
                  <TextCover id={t.artifactId} title={t.title} eyebrow={`Шаблон · ${formatLabel(t.mime)}`} note={`v${t.revisionNumber}`} />
                </button>
                <div className="template-card-body">
                  <h2>{t.title}</h2>
                  <p>{t.summary}</p>
                  <div className="template-card-meta">
                    <Badge tone={t.isLatest ? "accent" : "neutral"}>v{t.revisionNumber}{t.isLatest ? "" : " · предыдущий"}</Badge>
                    <span>{formatLabel(t.mime)}</span>
                  </div>
                </div>
                <div className="template-card-actions">
                  <Button variant="primary" onClick={() => setSelected(t)}>
                    <Sparkles /> Для агента
                  </Button>
                  {isHtmlTemplate(t) && libraryId && t.publicationId ? <Button variant="quiet" onClick={() => openPreview(t)}><Eye /> Предпросмотр</Button> :
                    isHtmlTemplate(t) ? <LinkButton variant="quiet" href={savedWorkHref(t.artifactId, `?revision=${t.revisionId}`)}>Работа <ArrowUpRight /></LinkButton> :
                      <Button variant="quiet" onClick={() => setSelected(t)}><FileCode2 /> Исходники</Button>}
                </div>
              </article>
            ))}
          </div>
        )}
        {loaded && hasMore && <p className="fine templates-more" role="status">Показаны первые 100 совпадений. Уточните поиск по названию или назначению.</p>}
      </main>
      {selected && (
        <AgentContextPanel
          key={selected.releaseId}
          artifactId={selected.artifactId}
          revisionId={selected.revisionId}
          libraryId={selected.libraryId}
          publicationId={selected.publicationId}
          onClose={() => setSelected(null)}
        />
      )}
      {preview && (
        <TemplateLibraryPreview
          key={`${account?.id}:${preview.libraryId}:${preview.publicationId}:${preview.revisionId}`}
          template={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </AppShell>
  );
}
