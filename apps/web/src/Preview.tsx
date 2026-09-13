import React, { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import type { Revision } from "../../../packages/contracts/index.ts";
import { bytes } from "./client.ts";
import { isImage } from "./format.ts";
export function Preview({
  revision,
  grant,
  compact = false,
}: {
  revision: Revision;
  grant?: string;
  compact?: boolean;
}) {
  const [content, setContent] = useState<{ url?: string; text?: string }>({}),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    setContent({});
    setError("");
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
            <span className="eyebrow">ЗАМЕТКИ И ИДЕИ</span>
            <p>{content.text.slice(0, 180)}</p>
            <FileText />
          </>
        ) : (
          <pre>{content.text}</pre>
        )}
      </div>
    );
  return <div className="placeholder" aria-label="Загрузка материала…" />;
}
