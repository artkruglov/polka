import React, { useEffect, useState } from "react";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { request } from "../../shared/api/client.ts";
import { Button, LinkButton, EmptyState, TextField, Badge, SelectField } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
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
  return (
    <AppShell current="shelf" account={account} className="p-modern">
      <main className="p-main">
        <header className="entry-heading">
          <h1>{selectedLibrary?.name || "Мои шаблоны"}</h1>
          <p>
            Оформление, структура и правила — для следующей задачи в вашем
            агенте.
          </p>
        </header>
        {account && (librariesLoading || libraries.length > 0 || libraryError) && (
          <div className="template-library-picker">
            <SelectField label="Каталог шаблонов" value={libraryId} onChange={(event) => selectLibrary(event.target.value)}>
              <option value="">Мои шаблоны</option>
              {libraries.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}
            </SelectField>
            <p className="fine">Общая библиотека показывает опубликованные версии, доступные вашей команде.</p>
          </div>
        )}
        {account && <div className="template-library-create"><CreateLibrary key={account.id} accountId={account.id} onCreated={(library) => {
          setLibraries((current) => [library, ...current]);
          selectLibrary(library.id);
        }} /></div>}
        {account && selectedLibrary && <TemplateLibraryManagement
          key={`${account.id}:${selectedLibrary.id}`}
          library={selectedLibrary}
          account={account}
          personalReleases={personalReleases}
          onRefreshCatalog={() => setAttempt((value) => value + 1)}
          onRefreshLibraries={() => setLibraryAttempt((value) => value + 1)}
        />}
        {account && selectedLibrary && personalError && <div><ErrorNotice error={personalError} /><Button onClick={() => setPersonalAttempt((value) => value + 1)}>Повторить загрузку личных выпусков</Button></div>}
        {account && <form className="template-search" onSubmit={(event) => {
          event.preventDefault(); setQuery(draftQuery.trim());
        }}>
          <div className="template-search-row">
            <TextField label="Найти шаблон" type="search" value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)} maxLength={200}
              placeholder="Например, отчёт команды или предложение клиенту" />
            <Button type="submit">Найти</Button>
          </div>
          <label className="template-history-toggle">
            <input type="checkbox" checked={includePrevious}
              onChange={(event) => setIncludePrevious(event.target.checked)} />
            Показать предыдущие выпуски
          </label>
          <p className="fine">По умолчанию — последний закреплённый выпуск каждого шаблона. Задачу опишите в своём агенте.</p>
        </form>}
        {account === null ? (
          <LinkButton href="/?login=1&next=%2Ftemplates">
            Войти в свою Полку
          </LinkButton>
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
          <p role="status">Загружаем шаблоны…</p>
        ) : items.length === 0 && query ? (
          <EmptyState title="Подходящих шаблонов не найдено" action={<Button onClick={() => {
            setDraftQuery(""); setQuery("");
          }}>Сбросить поиск</Button>}>
            Попробуйте название материала или его назначение. Для старых выпусков включите показ предыдущих версий.
          </EmptyState>
        ) : items.length === 0 && libraryId ? (
          <EmptyState title="В библиотеке пока нет опубликованных шаблонов">
            Здесь появятся версии, которые опубликует администратор или куратор библиотеки.
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState
            title="Сохраните первый шаблон"
            action={<LinkButton href="/">Открыть Мою Полку</LinkButton>}
          >
            Откройте материал → «Скопировать для агента» → «Сохранить эту версию
            как шаблон». Исходники и правила останутся вместе.
          </EmptyState>
        ) : (
          <div className="template-catalog">
            {items.map((t) => (
              <article className="template-card" key={t.releaseId}>
                <h2>{t.title}</h2>
                <p><Badge tone={t.isLatest ? "success" : "neutral"}>v{t.revisionNumber} · {t.isLatest ? "последний выпуск" : "предыдущий выпуск"}</Badge></p>
                <p>{t.summary}</p>
                <p className="template-format">Формат: {formatLabel(t.mime)}</p>
                <Button variant="primary" onClick={() => setSelected(t)}>
                  Скопировать для агента
                </Button>
                {isHtmlTemplate(t) && libraryId && t.publicationId ? <Button onClick={() => openPreview(t)}>Предпросмотр</Button> :
                  isHtmlTemplate(t) ? <a href={`/works/${t.artifactId}?revision=${t.revisionId}`}>Посмотреть материал</a> :
                    <Button onClick={() => setSelected(t)}>Исходники</Button>}
              </article>
            ))}
          </div>
        )}
        {loaded && hasMore && <p role="status">Показаны первые 100 совпадений. Уточните поиск по названию или назначению.</p>}
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
