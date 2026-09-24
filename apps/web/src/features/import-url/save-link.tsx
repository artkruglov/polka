import React, { useRef, useState } from "react";
import { Bookmark, ExternalLink } from "lucide-react";
import { MAX_LINK_NOTE, MAX_TITLE } from "../../../../../packages/contracts/constants.ts";
import { defaultLinkTitle } from "../../../../../packages/contracts/link-providers.ts";
import { request } from "../../shared/api/client.ts";
import { Button, LinkButton, TextAreaField, TextField } from "../../shared/ui/controls.tsx";

type Saved = { artifactId: string; title: string };

/**
 * «Сохранить как ссылку» (docs/specs/SAVED_LINKS.md): when the content cannot
 * be copied, the link itself becomes a work. Title (prefilled from the
 * provider table) and an optional note; the recipient of its share link gets
 * a card that leads to the original.
 */
export function SaveLinkAction({
  url,
  folderId,
}: {
  url: string;
  folderId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(() => defaultLinkTitle(url));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Saved | null>(null);
  const key = useRef(crypto.randomUUID());
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const receipt = await request<Saved>("/links", {
        key: key.current,
        url,
        title: title.trim() || defaultLinkTitle(url),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(folderId ? { folderId } : {}),
      });
      setSaved(receipt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить ссылку.");
    } finally {
      setBusy(false);
    }
  };
  if (saved)
    return (
      <div className="url-import-action" data-action="link" role="status">
        <Bookmark aria-hidden="true" />
        <div>
          <strong>«{saved.title}» на полке как ссылка</strong>
          <p>Получатель откроет оригинал по кнопке на карточке, если у него есть к нему доступ.</p>
        </div>
        <LinkButton href={`/works/${saved.artifactId}`}>
          <ExternalLink /> Открыть на полке
        </LinkButton>
      </div>
    );
  return (
    <div className="url-import-action" data-action="link">
      <Bookmark aria-hidden="true" />
      <div>
        <strong>Сохранить как ссылку</strong>
        <p>Полка сохранит адрес с названием и заметкой, без копии содержимого. Получатель откроет оригинал.</p>
        {open && (
          <form className="url-import-link-form" onSubmit={save}>
            <TextField
              label="Название"
              value={title}
              maxLength={MAX_TITLE}
              required
              onChange={(event) => {
                setTitle(event.target.value);
                key.current = crypto.randomUUID();
              }}
            />
            <TextAreaField
              label="Заметка (необязательно)"
              value={note}
              maxLength={MAX_LINK_NOTE}
              rows={2}
              onChange={(event) => {
                setNote(event.target.value);
                key.current = crypto.randomUUID();
              }}
            />
            {error && (
              <p className="ui-field-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" busy={busy}>
              Сохранить ссылку
            </Button>
          </form>
        )}
      </div>
      {!open && <Button onClick={() => setOpen(true)}>Сохранить как ссылку</Button>}
    </div>
  );
}
