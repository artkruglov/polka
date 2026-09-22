import "./styles.css";
import React, { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, LockKeyhole, LogIn } from "lucide-react";
import type {
  Artifact,
  Receipt,
} from "../../../../../packages/contracts/index.ts";
import { size } from "../../entities/artifact/format.ts";
import { useAccountState } from "../../entities/account/model/useAccount.ts";
import { useFolders } from "../../entities/folder/useFolders.ts";
import { FolderSelect } from "../../entities/folder/FolderSelect.tsx";
import { useSaveUpload } from "../../entities/artifact/useSaveUpload.ts";
import { SavedReceipt } from "../../entities/artifact/SavedReceipt.tsx";
import { Button, LinkButton, TextAreaField, TextField } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { describePaste } from "./model.ts";

const PASTE_CODE_LOGIN = `/signup?next=${encodeURIComponent("/bring#paste")}`;

/**
 * For people without a connector: paste the artifact's code copied from the
 * chat. It is saved through the same upload path as a file (begin → bytes →
 * finalize); the page composes the receipt through `renderResult`.
 */
export function PasteCode({
  initialFolderId = "",
  renderResult,
  embedded = false,
  titled = true,
}: {
  initialFolderId?: string;
  renderResult: (
    saved: { receipt: Receipt; work: Artifact },
    restart: () => void,
  ) => React.ReactNode;
  /** Rendered inside the link guide: no heading of its own, no page anchor. */
  embedded?: boolean;
  /** False when a surrounding tab already names the card: the heading stays for screen readers. */
  titled?: boolean;
}) {
  const { account, error: accountError, retry: retryAccount } = useAccountState();
  const folders = useFolders(account?.id);
  const [folderId, setFolderId] = useState(initialFolderId);
  const [code, setCode] = useState(""),
    [title, setTitle] = useState("");
  const upload = useSaveUpload();
  const suggested = useRef(""),
    card = useRef<HTMLElement>(null),
    busy = upload.busy;
  const pasted = describePaste(code);

  useEffect(() => {
    if (!embedded && location.hash === "#paste") card.current?.scrollIntoView();
  }, [embedded]);

  const edit = (next: string) => {
    setCode(next);
    upload.invalidate();
    const previous = suggested.current,
      proposal = describePaste(next)?.title ?? "";
    suggested.current = proposal;
    // Follow the page's own title until the author types one.
    setTitle((current) => (current === previous ? proposal : current));
  };

  const save = async () => {
    if (!pasted || !title.trim())
      return upload.setError("Вставьте код и укажите название.");
    if (pasted.tooLarge) return upload.setError("Код больше 5 МБ.");
    await upload.save(new Blob([code], { type: pasted.mime }), {
      title: title.trim(),
      filename: pasted.filename,
      folderId: folderId || null,
    });
  };

  const restart = () => {
    upload.reset();
    suggested.current = "";
    setCode("");
    setTitle("");
  };

  const guest = account === null;
  const saved = upload.saved;

  return (
    <section
      className={embedded ? "paste-code paste-code--embedded" : "paste-code"}
      id={embedded ? undefined : "paste"}
      ref={card}
      aria-labelledby={embedded ? undefined : "paste-code-title"}
      aria-label={embedded ? "Вставить код артефакта" : undefined}
    >
      {saved?.work ? (
        renderResult({ receipt: saved.receipt, work: saved.work }, restart)
      ) : saved ? (
        <SavedReceipt
          receipt={saved.receipt}
          error={upload.error}
          busy={busy}
          onShow={() => void upload.showSaved(saved.receipt)}
          onRestart={restart}
          restartLabel="Вставить другой код"
        />
      ) : (
        <div className="bring-entry paste-code-entry">
          {!embedded && (
            <>
              <div className={titled ? "paste-code-head" : "paste-code-head sr-only"}>
                <h2 id="paste-code-title">Вставить код</h2>
              </div>
              <p className="paste-code-hint">
                Нет файла? В Claude или ChatGPT откройте артефакт, нажмите
                «Копировать» (Copy) и вставьте код сюда. HTML сохранится
                страницей, всё остальное — текстом.
              </p>
            </>
          )}
          <TextAreaField
            label="Код артефакта"
            className="paste-code-input"
            rows={embedded ? 8 : 12}
            value={code}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={busy}
            placeholder={"<!doctype html>\n<html>…</html>"}
            onChange={(e) => edit(e.target.value)}
          />
          {pasted && (
            <p
              className={pasted.kind === "component" || pasted.tooLarge ? "paste-code-kind warn" : "paste-code-kind"}
              role="status"
              data-kind={pasted.kind}
            >
              {pasted.kind === "component" || pasted.tooLarge ? <CircleAlert /> : <Check />}
              <span>
                {pasted.tooLarge
                  ? `${size(pasted.size)} — больше 5 МБ, такой код Полка не примет. Уберите встроенные шрифты и крупные картинки.`
                  : pasted.kind === "html"
                    ? `HTML-страница · ${size(pasted.size)}. Как она откроется у получателя, покажем после сохранения.`
                    : pasted.kind === "text"
                      ? `Текст · ${size(pasted.size)}. Сохранится заметкой, как написан, без оформления.`
                      : "Это исходный код компонента (React или JS-модуль), а не готовая страница: Полка сохранит его как текст. Чтобы получилась страница, попросите в чате «Собери это в один HTML-файл без внешних ссылок» и вставьте результат."}
              </span>
            </p>
          )}
          {account && pasted && (
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
          <ErrorNotice error={upload.error} />
          {guest ? (
            <div className="paste-code-login" role="note">
              <p>
                {pasted
                  ? "Код ещё не сохранён и никуда не отправлен. Сохранять можно только на свою полку — войдите. После входа вернём сюда; код нужно будет вставить ещё раз."
                  : "Сохранение идёт на вашу полку, поэтому сначала нужен вход. После входа вернём сюда."}
              </p>
              <div className="bring-actions">
                <LinkButton
                  variant="primary"
                  href={
                    initialFolderId
                      ? `/signup?next=${encodeURIComponent(`/bring?folder=${encodeURIComponent(initialFolderId)}#paste`)}`
                      : PASTE_CODE_LOGIN
                  }
                >
                  <LogIn /> {pasted ? "Войти, чтобы продолжить" : "Войти, чтобы сохранить"}
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
              <p className="paste-code-hint" role="status">
                Проверяем вход…
              </p>
            )
          ) : (
            <div className="bring-actions">
              <Button
                type="button"
                variant="primary"
                onClick={save}
                disabled={!pasted || pasted.tooLarge || busy}
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
