import React, { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import type { Revision } from "../../../../../packages/contracts/index.ts";
import { bytes } from "../../shared/api/client.ts";
import {
  isImage,
  isStaticSingleFileBundle,
  size,
} from "../../entities/artifact/format.ts";
import { LivePreview } from "./LivePreview.tsx";
import { StatusPanel } from "../../shared/ui/controls.tsx";
import { Wave } from "../../shared/ui/Wave.tsx";
export function Preview({
  revision,
  grant,
  compact = false,
  readingTitle,
  onInlineBuildChange,
}: {
  revision: Revision;
  grant?: string;
  compact?: boolean;
  readingTitle?: string;
  onInlineBuildChange?: () => Promise<void>;
}) {
  const [content, setContent] = useState<{ url?: string; text?: string }>({}),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    setContent({});
    setError("");
    if (revision.mime === "text/html" || revision.storageKind === "bundle")
      return () => abort.abort();
    bytes(
      grant ? "/view/bytes" : `/revisions/${revision.id}/bytes`,
      grant,
      abort.signal,
    )
      .then(async (blob) => {
        if (abort.signal.aborted) return;
        if (isImage(revision)) {
          url = URL.createObjectURL(blob);
          setContent({ url });
        } else {
          const text = await blob.text();
          if (!abort.signal.aborted) setContent({ text });
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [revision.id, grant]);
  if (error) return <div className="preview-error">{error}</div>;
  // A lone static page saved as a bundle is shown like a single HTML upload.
  if (
    revision.storageKind === "bundle" &&
    !isStaticSingleFileBundle(revision)
  ) {
    const fallback = (
      <StatusPanel
        title="Копия сохранена"
        compact={compact}
        action={
          !compact &&
          !grant && (
            <a
              className="ui-button"
              href={`/api/revisions/${revision.id}/export`}
              download
            >
              Скачать весь пакет
            </a>
          )
        }
      >
        {revision.inlineBuild?.state === "ready"
          ? "Просмотр готов. Нажмите «Запустить» ниже."
          : "Просмотр пакета ещё недоступен."}{" "}
        Размер: {size(revision.totalSize)}.
      </StatusPanel>
    );
    if (compact) return fallback;
    return (
      <LivePreview
        key={`${revision.id}:${grant ?? ""}`}
        revision={revision}
        grant={grant}
        requiresBuild
        onInlineBuildChange={onInlineBuildChange}
      >
        {fallback}
      </LivePreview>
    );
  }
  // The server refuses to render unsupported pages at all; say so instead of a broken frame.
  if (revision.mime === "text/html" && revision.htmlProfile === "unsupported") {
    const fallback = (
      <div className="preview-error">
        {compact
          ? "Страница без просмотра"
          : "Эту страницу нельзя показать в безопасном просмотре: ей нужны скрипты или внешние ресурсы. Оригинал сохранён и доступен для скачивания."}
      </div>
    );
    return compact ? (
      fallback
    ) : (
      <LivePreview
        key={`${revision.id}:${grant ?? ""}`}
        revision={revision}
        grant={grant}
        requiresBuild={false}
        onInlineBuildChange={onInlineBuildChange}
      >
        {fallback}
      </LivePreview>
    );
  }
  if (revision.mime === "text/html") {
    const fallback = (
      <div className="html-preview">
        <SandboxFrame
          title={revision.filename}
          src={
            grant
              ? `/api/view/${grant}/document`
              : `/api/revisions/${revision.id}/document`
          }
        />
        {revision.htmlProfile === "limited" && (
          <p className="html-preview-note">
            Интерактивные действия отключены в безопасном просмотре; показана
            сохранённая версия страницы.
          </p>
        )}
      </div>
    );
    return compact ? (
      fallback
    ) : (
      <LivePreview
        key={`${revision.id}:${grant ?? ""}`}
        revision={revision}
        grant={grant}
        requiresBuild={revision.storageKind === "bundle"}
        onInlineBuildChange={onInlineBuildChange}
      >
        {fallback}
      </LivePreview>
    );
  }
  if (content.url)
    return (
      <img
        className={compact ? "cover-image" : "work-image"}
        src={content.url}
        alt={compact ? "" : revision.filename}
        onError={() =>
          setError(
            "Не удалось показать изображение. Оригинал сохранён и доступен для скачивания.",
          )
        }
      />
    );
  if (content.text !== undefined)
    return (
      <div className={compact ? "cover-text" : "work-text"}>
        {compact ? (
          <>
            <span className="eyebrow">Заметка</span>
            <p>{content.text.slice(0, 180)}</p>
            <FileText />
          </>
        ) : readingTitle ? (
          <ReadingText text={content.text} title={readingTitle} />
        ) : (
          <pre>{content.text}</pre>
        )}
      </div>
    );
  return <div className="placeholder" aria-label="Загрузка материала…" />;
}

/** The sandboxed document can take seconds to arrive; say so instead of showing a blank frame. */
function SandboxFrame({ src, title }: { src: string; title: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="html-preview-frame" data-loaded={loaded || undefined}>
      {!loaded && (
        <div className="html-preview-loading" role="status">
          <span className="ui-spinner" aria-hidden="true" />
          Загружаем безопасный просмотр…
        </div>
      )}
      <iframe
        className="work-html"
        title={title}
        src={src}
        sandbox=""
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}

/** Read-only typography for plain text. Never interprets source as HTML. */
function ReadingText({ text, title }: { text: string; title: string }) {
  const blocks = text.trim().split(/\r?\n\s*\r?\n/);
  const normalize = (value: string) =>
    value
      .replace(/\s+/g, " ")
      .replace(/[.!?]+$/, "")
      .trim();
  const hasHeading = normalize(blocks[0] || "") === normalize(title);
  const heading = hasHeading ? blocks.shift()! : title;
  const lead =
    hasHeading && blocks[0]?.length < 120 ? blocks.shift() : undefined;
  return (
    <article className="reading-article">
      <span className="reading-eyebrow">Заметка</span>
      <h1>{heading}</h1>
      {lead && <p className="reading-lead">{lead}</p>}
      <Wave compact className="reading-wave" />
      <div className="reading-body">
        {blocks.map((block, i) => (
          <p key={i}>{block}</p>
        ))}
      </div>
    </article>
  );
}
