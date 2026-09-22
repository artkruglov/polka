import "./styles.css";
import { useFolders } from "../../entities/folder/useFolders.ts";
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  Copy,
  FileUp,
  Link2,
  LockKeyhole,
  LogIn,
} from "lucide-react";
import type {
  Account,
  Artifact,
  Receipt,
  Revision,
} from "../../../../../packages/contracts/index.ts";
import { MAX_BYTES, MIME } from "../../../../../packages/contracts/index.ts";
import {
  client,
  fileMime,
  saveUpload,
  type PendingUpload,
} from "../../shared/api/client.ts";
import { date, profileView, size } from "../../entities/artifact/format.ts";
import { fallbackTitle, suggestTitle } from "../../entities/artifact/html-title.ts";
import { Button, LinkButton, SelectField, TextField } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { Status } from "../../shared/ui/Status.tsx";

/** Where login returns the guest: back to this card. */
export const FILE_SAVE_LOGIN = `/signup?next=${encodeURIComponent("/bring#file")}`;

/**
 * The real file path of /bring: begin → bytes → finalize through the existing API,
 * then an optional link. Nothing here is a fixture: title, receipt, profile and URL come from the server.
 * A guest can pick a file, but it never leaves the page before login; the browser cannot carry it across the redirect.
 */
export function FileSave({
  account,
  initialFolderId = "",
  renderPreview,
  embedded = false,
}: {
  account: Account | null | undefined;
  initialFolderId?: string;
  renderPreview: (revision: Revision, compact: boolean) => React.ReactNode;
  /** Rendered inside the link guide: no heading of its own, no page anchor. */
  embedded?: boolean;
}) {
  const folders = useFolders(account?.id);
  const [folderId, setFolderId] = useState(initialFolderId);
  const [file, setFile] = useState<File | null>(null),
    [title, setTitle] = useState(""),
    [stage, setStage] = useState(""),
    [error, setError] = useState(""),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [work, setWork] = useState<Artifact | null>(null),
    [sharing, setSharing] = useState(false),
    [copied, setCopied] = useState(false),
    [dragging, setDragging] = useState(false);
  const operation = useRef<PendingUpload | null>(null),
    picked = useRef<File | null>(null),
    card = useRef<HTMLElement>(null),
    busy = !!stage || sharing;

  useEffect(() => {
    if (!embedded && location.hash === "#file") card.current?.scrollIntoView();
  }, [embedded]);

  const pick = (f: File | undefined) => {
    if (!f) return;
    picked.current = f;
    operation.current = null;
    setError("");
    setFile(f);
    const fallback = fallbackTitle(f);
    setTitle(fallback);
    // HTML pages usually name themselves; replace the file name unless the author already typed.
    void suggestTitle(f).then((suggested) => {
      if (picked.current === f)
        setTitle((current) => (current === fallback ? suggested : current));
    });
    const mime = fileMime(f);
    if (!(MIME as readonly string[]).includes(mime))
      setError(
        "Этот тип файла не поддерживается. Подойдут HTML, TXT, PNG, JPEG или WebP. ZIP и PDF эта сборка не принимает.",
      );
    else if (f.size > MAX_BYTES) setError("Файл больше 5 МБ.");
  };

  const save = async () => {
    if (!file || !title.trim())
      return setError("Выберите файл и укажите название.");
    const blob = new Blob([file], { type: fileMime(file) });
    if (
      !(MIME as readonly string[]).includes(blob.type) ||
      blob.size > MAX_BYTES
    )
      return setError("Подойдут HTML, TXT, PNG, JPEG или WebP до 5 МБ.");
    setError("");
    operation.current ??= { file: blob, key: crypto.randomUUID() };
    try {
      const saved = await saveUpload(
        operation.current,
        { title: title.trim(), filename: file.name, folderId: folderId || null },
        setStage,
      );
      setReceipt(saved);
      setWork(await client.artifact(saved.artifactId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStage("");
    }
  };

  const share = async () => {
    if (!work) return;
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

  const restart = () => {
    operation.current = null;
    setFile(null);
    setTitle("");
    setReceipt(null);
    setWork(null);
    setError("");
    setCopied(false);
  };

  const guest = account === null;
  const view = work ? profileView(work.revision) : null;
  const link =
    work?.share && work.share.status === "active" ? work.share : null;

  return (
    <section
      className={embedded ? "file-save file-save--embedded" : "file-save"}
      id={embedded ? undefined : "file"}
      ref={card}
      aria-labelledby={embedded ? undefined : "file-save-title"}
      aria-label={embedded ? "Загрузить скачанный файл" : undefined}
    >
      {receipt && work && view ? (
        <div className="bring-result">
          <span className="result-kicker ok">
            <Check /> Сохранено на полке · версия {receipt.number}
          </span>
          <h2 id={embedded ? undefined : "file-save-title"} tabIndex={-1}>
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
          <ul
            className="profile-now-plan"
            aria-label="Как откроется у получателя"
          >
            <li>
              <Status is={view.linkable ? "real" : "unsupported"} />{" "}
              <strong>Сейчас:</strong> {view.now}
            </li>
            {view.plan && (
              <li>
                <Status is="plan" /> <strong>В плане:</strong> {view.plan}
              </li>
            )}
          </ul>
          <div className="file-save-preview">
            {renderPreview(work.revision, !view.linkable)}
          </div>
          {link ? (
            <div className="share-ready" role="status">
              <div>
                <Link2 />
                <code>{link.url}</code>
              </div>
              <div className="share-ready-actions">
                <Button
                  type="button"
                  variant="primary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link.url!);
                      setCopied(true);
                    } catch {
                      setError("Не удалось скопировать. Выделите адрес выше.");
                    }
                  }}
                >
                  {copied ? <Check /> : <Copy />}{" "}
                  {copied ? "Скопировано" : "Скопировать ссылку"}
                </Button>
                <LinkButton href={link.url!} target="_blank" rel="noopener">
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
            <Button type="button" variant="quiet" onClick={restart} disabled={busy}>
              Сохранить другой файл
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
                ". Отозвать её или обновить до новой версии можно в Моей Полке."
              : view.linkable
                ? "Ссылка — отдельное действие. Её можно отозвать в Моей Полке."
                : "Сохраните версию без скриптов и внешних ресурсов, чтобы отправить её ссылкой."}
          </p>
        </div>
      ) : (
        <div className="bring-entry file-save-entry">
          {!embedded && (
            <>
              <div className="file-save-head">
                <h2 id="file-save-title">Загрузить файл</h2>
                <Status is="real" />
              </div>
              <p className="file-save-hint">
                HTML из чата, заметка или изображение. Сначала откроется
                сохранённый вид; интерактивный просмотр, если он доступен,
                запускается отдельно.
              </p>
            </>
          )}
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
                {file
                  ? `${size(file.size)} · ещё не сохранено`
                  : "HTML, TXT, PNG, JPEG, WebP · до 5 МБ"}
              </small>
            </span>
            <input
              type="file"
              accept="text/html,.html,.htm,text/plain,.txt,image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {account && <SelectField label="Куда сохранить" value={folderId} disabled={busy || folders.loading} error={folders.error} onChange={e => {setFolderId(e.target.value); operation.current = null;}}>
            <option value="">Моя Полка — без папки</option>
            {folderId && !folders.items.some(f => f.id === folderId) && <option value={folderId}>{folders.loading ? "Проверяем выбранную папку…" : "Выбранная папка недоступна"}</option>}
            {folders.items.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </SelectField>}
          {folders.error && <Button onClick={folders.retry}>Загрузить папки снова</Button>}
          {file && account && (
            <TextField
              label="Название"
              value={title}
              maxLength={160}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
          <ErrorNotice error={error} />
          {guest ? (
            <div className="file-save-login" role="note">
              <p>
                {file
                  ? "Файл ещё не сохранён и не отправлен на сервер. Сохранять можно только на свою Полку — войдите. После входа вернём сюда; файл нужно будет выбрать ещё раз."
                  : "Сохранение идёт на вашу Полку, поэтому сначала нужен вход. После входа вернём сюда."}
              </p>
              <div className="bring-actions">
                <LinkButton variant="primary" href={initialFolderId ? `/signup?next=${encodeURIComponent(`/bring?folder=${encodeURIComponent(initialFolderId)}#file`)}` : FILE_SAVE_LOGIN}>
                  <LogIn />{" "}
                  {file ? "Войти, чтобы продолжить" : "Войти, чтобы сохранить"}
                </LinkButton>
              </div>
            </div>
          ) : account === undefined ? (
            <p className="file-save-hint" role="status">
              Проверяем вход…
            </p>
          ) : (
            <div className="bring-actions">
              <Button
                type="button"
                variant="primary"
                onClick={save}
                disabled={!file || busy}
              >
                <LockKeyhole />{" "}
                {stage ||
                  (error && operation.current
                    ? "Повторить сохранение"
                    : "Сохранить на Полку")}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
