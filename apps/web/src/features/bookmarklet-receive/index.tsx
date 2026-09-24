import "./styles.css";
import React, { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, LockKeyhole, LogIn } from "lucide-react";
import type { BookmarkletSource } from "../../../../../packages/contracts/bookmarklet.ts";
import { useAccountState } from "../../entities/account/model/useAccount.ts";
import { size } from "../../entities/artifact/format.ts";
import { useSaveUpload } from "../../entities/artifact/useSaveUpload.ts";
import { FolderSelect } from "../../entities/folder/FolderSelect.tsx";
import { useFolders } from "../../entities/folder/useFolders.ts";
import { Button, LinkButton, TextField } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { clearPending, savePending, sourceSize, toUpload } from "./model.ts";

export {
  FAILURE_TEXT,
  clearPending,
  loadPending,
  useBookmarkletMessage,
  type Received,
} from "./model.ts";

const RECEIVE_LOGIN = `/signup?next=${encodeURIComponent("/bring/receive")}`;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * What the «На Полку» bookmark sent, before it is saved: an editable title,
 * where it came from, its size, and one button. Saved through the same upload
 * path as «Загрузить файл», with the page's address in provenance; then the
 * work's page (with «Поделиться») opens.
 */
export function ReceivedCard({
  source,
  onDismiss,
}: {
  source: BookmarkletSource;
  onDismiss: () => void;
}) {
  const { account, error: accountError, retry } = useAccountState();
  const folders = useFolders(account?.id);
  const [folderId, setFolderId] = useState("");
  const [title, setTitle] = useState(source.title || hostOf(source.url));
  const upload = useSaveUpload();
  const bytes = useMemo(() => sourceSize(source), [source]);
  const [kept, setKept] = useState(true);

  // A guest signs in first: keep the data in this tab for the way back.
  useEffect(() => {
    if (account === null) setKept(savePending(source));
  }, [account, source]);

  // Saved: the work's own page, where «Поделиться» is.
  useEffect(() => {
    if (!upload.saved) return;
    clearPending();
    location.assign(`/works/${upload.saved.receipt.artifactId}`);
  }, [upload.saved]);

  const save = async () => {
    if (!title.trim()) return upload.setError("Укажите название.");
    const file = toUpload(source, title.trim());
    if (file.tooLarge) return upload.setError("Больше 5 МБ: такой файл Полка не примет.");
    await upload.save(file.blob, {
      title: title.trim(),
      filename: file.filename,
      folderId: folderId || null,
      ...(file.sourceUrl ? { sourceUrl: file.sourceUrl } : {}),
    });
  };

  const snapshot = source.kind === "snapshot";
  const component = source.language === "jsx" || source.language === "tsx";
  return (
    <section className="receive-card" aria-labelledby="receive-title">
      <span className="receive-kicker">{snapshot ? "Снимок страницы" : "Артефакт"} · ещё не сохранено</span>
      <h2 id="receive-title" className="sr-only">
        Сохранить на полку
      </h2>
      <dl className="receive-facts">
        <div>
          <dt>Откуда</dt>
          <dd>
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              {hostOf(source.url)} <ArrowUpRight aria-hidden="true" />
            </a>
          </dd>
        </div>
        <div>
          <dt>Размер</dt>
          <dd>{size(bytes)}</dd>
        </div>
        <div>
          <dt>Сохранится</dt>
          <dd>
            {snapshot
              ? "страницей без скриптов: как она выглядела, без интерактива"
              : component
                ? "исходным кодом компонента, текстом"
                : source.language === "html"
                  ? "HTML-страницей, как её сделал чат"
                  : "текстом, как написан"}
          </dd>
        </div>
      </dl>
      {account ? (
        <>
          <TextField
            label="Название"
            value={title}
            maxLength={160}
            disabled={upload.busy}
            onChange={(event) => {
              setTitle(event.target.value);
              upload.invalidate();
            }}
          />
          <FolderSelect
            folders={folders}
            value={folderId}
            disabled={upload.busy}
            onChange={(next) => {
              setFolderId(next);
              upload.invalidate();
            }}
          />
          <ErrorNotice error={upload.error} />
          <div className="bring-actions receive-actions">
            <Button type="button" variant="primary" onClick={save} disabled={upload.busy}>
              <LockKeyhole />{" "}
              {upload.stage || (upload.retrying ? "Повторить сохранение" : "Сохранить на полку")}
            </Button>
            <Button type="button" variant="quiet" onClick={onDismiss} disabled={upload.busy}>
              Не сохранять
            </Button>
          </div>
          <p className="receive-hint">Сначала работу видите только вы. Ссылку можно создать после сохранения.</p>
        </>
      ) : account === null ? (
        <div className="receive-login" role="note">
          <p>
            {kept
              ? "Сохранять можно только на свою полку — войдите. Данные останутся в этой вкладке и никуда не отправлены; после входа вернём сюда."
              : "Сохранять можно только на свою полку. Браузер не дал сохранить данные на время входа: войдите в соседней вкладке и нажмите закладку ещё раз."}
          </p>
          <div className="bring-actions">
            <LinkButton variant="primary" href={RECEIVE_LOGIN} target={kept ? undefined : "_blank"}>
              <LogIn /> Войти, чтобы сохранить
            </LinkButton>
          </div>
        </div>
      ) : accountError ? (
        <div className="bring-actions">
          <ErrorNotice error={`Не удалось проверить вход. ${accountError}`} />
          <Button onClick={retry}>Проверить снова</Button>
        </div>
      ) : (
        <p className="receive-hint" role="status">
          Проверяем вход…
        </p>
      )}
    </section>
  );
}
