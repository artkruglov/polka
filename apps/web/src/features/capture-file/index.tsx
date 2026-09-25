import "./styles.css";
import { useFolders } from "../../entities/folder/useFolders.ts";
import { FolderSelect } from "../../entities/folder/FolderSelect.tsx";
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  FileUp,
  Link2,
  LockKeyhole,
  LogIn,
} from "lucide-react";
import type {
  Artifact,
  Receipt,
  Revision,
} from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import { useAccountState } from "../../entities/account/model/useAccount.ts";
import { date, profileView, size } from "../../entities/artifact/format.ts";
import { fallbackTitle, suggestTitle } from "../../entities/artifact/html-title.ts";
import {
  UPLOAD_ACCEPT,
  UPLOAD_FORMATS,
  uploadBlob,
  uploadProblem,
} from "../../entities/artifact/upload.ts";
import { useSaveUpload } from "../../entities/artifact/useSaveUpload.ts";
import { SavedReceipt } from "../../entities/artifact/SavedReceipt.tsx";
import { Button, LinkButton, TextField } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";

/** Where login returns the guest: back to this card. */
const FILE_SAVE_LOGIN = `/signup?next=${encodeURIComponent("/bring#file")}`;

/**
 * The real file path of /bring: begin → bytes → finalize through the existing API,
 * then an optional link. Nothing here is a fixture: title, receipt, profile and URL come from the server.
 * A guest can pick a file, but it never leaves the page before login; the browser cannot carry it across the redirect.
 */
export function FileSave({
  initialFolderId = "",
  renderPreview,
  titled = true,
}: {
  initialFolderId?: string;
  renderPreview: (revision: Revision, compact: boolean) => React.ReactNode;
  /** False when a surrounding tab already names the card: the heading stays for screen readers. */
  titled?: boolean;
}) {
  const { account, error: accountError, retry: retryAccount } = useAccountState();
  const folders = useFolders(account?.id);
  const [folderId, setFolderId] = useState(initialFolderId);
  const [file, setFile] = useState<File | null>(null),
    [title, setTitle] = useState(""),
    [dragging, setDragging] = useState(false);
  const upload = useSaveUpload();
  const picked = useRef<File | null>(null),
    card = useRef<HTMLElement>(null),
    busy = upload.busy;

  useEffect(() => {
    if (location.hash === "#file") card.current?.scrollIntoView();
  }, []);

  const pick = (f: File | undefined) => {
    if (!f) return;
    picked.current = f;
    upload.invalidate();
    setFile(f);
    const fallback = fallbackTitle(f);
    setTitle(fallback);
    // HTML pages usually name themselves; replace the file name unless the author already typed.
    void suggestTitle(f).then((suggested) => {
      if (picked.current === f)
        setTitle((current) => (current === fallback ? suggested : current));
    });
    const problem = uploadProblem(uploadBlob(f));
    if (problem) upload.setError(problem);
  };

  const save = async () => {
    if (!file || !title.trim())
      return upload.setError("Выберите файл и укажите название.");
    const blob = uploadBlob(file);
    const problem = uploadProblem(blob);
    if (problem) return upload.setError(problem);
    await upload.save(blob, {
      title: title.trim(),
      filename: file.name,
      folderId: folderId || null,
    });
  };

  const restart = () => {
    upload.reset();
    setFile(null);
    setTitle("");
  };

  const guest = account === null;
  const saved = upload.saved;

  return (
    <section
      className="file-save"
      id="file"
      ref={card}
      aria-labelledby="file-save-title"
    >
      {saved?.work ? (
        <SavedWork
          receipt={saved.receipt}
          work={saved.work}
          renderPreview={renderPreview}
          onRestart={restart}
          restartLabel="Сохранить другой файл"
          headingId="file-save-title"
        />
      ) : saved ? (
        <SavedReceipt
          receipt={saved.receipt}
          error={upload.error}
          busy={busy}
          onShow={() => void upload.showSaved(saved.receipt)}
          onRestart={restart}
          restartLabel="Сохранить другой файл"
        />
      ) : (
        <div className="bring-entry file-save-entry">
          <div className={titled ? "file-save-head" : "file-save-head sr-only"}>
            <h2 id="file-save-title">Загрузить файл</h2>
          </div>
          <p className="file-save-hint">
            HTML из чата, заметка или изображение. Сначала откроется
            сохранённый вид; интерактивный просмотр, если он доступен,
            запускается отдельно.
          </p>
          <label
            className={dragging ? "file-field dragging" : "file-field"}
            data-picked={!!file}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!busy) pick(e.dataTransfer.files[0]);
            }}
          >
            {file ? <Check /> : <FileUp />}
            <span>
              <strong>
                {file ? file.name : "Перетащите файл или нажмите, чтобы выбрать"}
              </strong>
              <small>
                {file ? `${size(file.size)} · ещё не сохранено` : UPLOAD_FORMATS}
              </small>
            </span>
            <input
              type="file"
              accept={UPLOAD_ACCEPT}
              disabled={busy}
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {account && (
            <FolderSelect
              folders={folders}
              value={folderId}
              disabled={busy}
              onChange={(next) => {
                setFolderId(next);
                upload.invalidate();
              }}
            />
          )}
          {file && account && (
            <TextField
              label="Название"
              value={title}
              maxLength={160}
              disabled={busy}
              onChange={(e) => {
                setTitle(e.target.value);
                upload.invalidate();
              }}
            />
          )}
          <ErrorNotice error={upload.error} />
          {guest ? (
            <div className="file-save-login" role="note">
              <p>
                {file
                  ? "Файл ещё не сохранён и не отправлен на сервер. Сохранять можно только на свою полку — войдите. После входа вернём сюда; файл нужно будет выбрать ещё раз."
                  : "Сохранение идёт на вашу полку, поэтому сначала нужен вход. После входа вернём сюда."}
              </p>
              <div className="bring-actions">
                <LinkButton variant="primary" href={initialFolderId ? `/signup?next=${encodeURIComponent(`/bring?folder=${encodeURIComponent(initialFolderId)}#file`)}` : FILE_SAVE_LOGIN}>
                  <LogIn />{" "}
                  {file ? "Войти, чтобы продолжить" : "Войти, чтобы сохранить"}
                </LinkButton>
              </div>
            </div>
          ) : account === undefined ? (
            accountError ? (
              <div className="bring-actions">
                <ErrorNotice error={`Не удалось проверить вход. ${accountError}`} />
                <Button onClick={retryAccount}>Проверить снова</Button>
              </div>
            ) : (
              <p className="file-save-hint" role="status">
                Проверяем вход…
              </p>
            )
          ) : (
            <div className="bring-actions">
              <Button
                type="button"
                variant="primary"
                onClick={save}
                disabled={!file || busy}
              >
                <LockKeyhole />{" "}
                {upload.stage ||
                  (upload.retrying ? "Повторить сохранение" : "Сохранить на полку")}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The receipt after a save from /bring: what was saved, how it opens, a
 * preview and the optional 30-day link. Shared by the file and paste paths.
 */
export function SavedWork({
  receipt,
  work: saved,
  renderPreview,
  onRestart,
  restartLabel,
  headingId,
}: {
  receipt: Receipt;
  work: Artifact;
  renderPreview: (revision: Revision, compact: boolean) => React.ReactNode;
  onRestart: () => void;
  restartLabel: string;
  headingId?: string;
}) {
  const [work, setWork] = useState(saved),
    [sharing, setSharing] = useState(false),
    [error, setError] = useState("");
  const busy = sharing;
  const view = profileView(work.revision);
  const link = work.share && work.share.status === "active" ? work.share : null;

  const share = async () => {
    setSharing(true);
    setError("");
    try {
      setWork(await client.enable(work, 30));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="bring-result">
      <span className="result-kicker ok">
        <Check /> Сохранено на полке · версия {receipt.number}
      </span>
      <h2 id={headingId} tabIndex={-1}>
        {work.title}
      </h2>
      <dl className="import-facts">
        <div>
          <dt>Файл</dt>
          <dd>
            {work.revision.filename} · {size(work.revision.size)}
          </dd>
        </div>
        <div>
          <dt>Доступ</dt>
          <dd>
            {link ? (
              <>
                <Link2 /> По ссылке до {date(link.expiresAt)}
              </>
            ) : (
              <>
                <LockKeyhole /> Только вы
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Как откроется</dt>
          <dd data-profile={work.revision.htmlProfile ?? "file"}>
            {view.label}
          </dd>
        </div>
      </dl>
      <p
        className={view.linkable ? "next-note" : "next-note warn"}
        role="note"
      >
        {view.linkable ? <Check /> : <CircleAlert />} {view.text}
      </p>
      <div className="file-save-preview">
        {renderPreview(work.revision, !view.linkable)}
      </div>
      {link?.url ? (
        <div className="share-ready" role="status">
          <div>
            <Link2 />
            <code>{link.url}</code>
          </div>
          <div className="share-ready-actions">
            <CopyButton
              value={link.url}
              variant="primary"
              label="Скопировать ссылку"
            />
            <LinkButton href={link.url} target="_blank" rel="noopener">
              Открыть как получатель <ArrowUpRight />
            </LinkButton>
          </div>
        </div>
      ) : null}
      <ErrorNotice error={error} />
      <div className="bring-actions">
        <LinkButton variant={view.linkable && !link ? "secondary" : "primary"} href={`/works/${work.id}`}>
          Открыть на полке <ArrowUpRight />
        </LinkButton>
        <Button type="button" variant="quiet" onClick={onRestart} disabled={busy}>
          {restartLabel}
        </Button>
        {view.linkable && !link && (
          <Button
            type="button"
            variant="primary"
            onClick={share}
            disabled={busy}
          >
            <Link2 />{" "}
            {sharing ? "Создаём ссылку…" : "Создать ссылку на 30 дней"}
          </Button>
        )}
      </div>
      <p className="bring-hint">
        {link
          ? "Ссылка открывает версию " +
            link.number +
            ". Отозвать её или обновить до новой версии можно на вашей полке."
          : view.linkable
            ? "Ссылка — отдельное действие. Её можно отозвать на вашей полке."
            : "Сохраните версию без скриптов и внешних ресурсов, чтобы отправить её ссылкой."}
      </p>
    </div>
  );
}
