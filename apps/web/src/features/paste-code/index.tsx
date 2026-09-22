import "./styles.css";
import React, { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, LockKeyhole, LogIn } from "lucide-react";
import type {
  Account,
  Artifact,
  Receipt,
} from "../../../../../packages/contracts/index.ts";
import { client, saveUpload, type PendingUpload } from "../../shared/api/client.ts";
import { size } from "../../entities/artifact/format.ts";
import { useFolders } from "../../entities/folder/useFolders.ts";
import { Button, LinkButton, SelectField, TextAreaField, TextField } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { Status } from "../../shared/ui/Status.tsx";
import { describePaste } from "./model.ts";

export const PASTE_CODE_LOGIN = `/signup?next=${encodeURIComponent("/bring#paste")}`;

/**
 * For people without a connector: paste the artifact's code copied from the
 * chat. It is saved through the same upload path as a file (begin → bytes →
 * finalize); the page composes the receipt through `renderResult`.
 */
export function PasteCode({
  account,
  initialFolderId = "",
  renderResult,
  embedded = false,
  titled = true,
}: {
  account: Account | null | undefined;
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
  const folders = useFolders(account?.id);
  const [folderId, setFolderId] = useState(initialFolderId);
  const [code, setCode] = useState(""),
    [title, setTitle] = useState(""),
    [stage, setStage] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState<{ receipt: Receipt; work: Artifact } | null>(null);
  const operation = useRef<PendingUpload | null>(null),
    suggested = useRef(""),
    card = useRef<HTMLElement>(null),
    busy = !!stage;
  const pasted = describePaste(code);

  useEffect(() => {
    if (!embedded && location.hash === "#paste") card.current?.scrollIntoView();
  }, [embedded]);

  const edit = (next: string) => {
    setCode(next);
    operation.current = null;
    setError("");
    const previous = suggested.current,
      proposal = describePaste(next)?.title ?? "";
    suggested.current = proposal;
    // Follow the page's own title until the author types one.
    setTitle((current) => (current === previous ? proposal : current));
  };

  const save = async () => {
    if (!pasted || !title.trim())
      return setError("Вставьте код и укажите название.");
    if (pasted.tooLarge) return setError("Код больше 5 МБ.");
    setError("");
    operation.current ??= {
      file: new Blob([code], { type: pasted.mime }),
      key: crypto.randomUUID(),
    };
    try {
      const receipt = await saveUpload(
        operation.current,
        { title: title.trim(), filename: pasted.filename, folderId: folderId || null },
        setStage,
      );
      setSaved({ receipt, work: await client.artifact(receipt.artifactId) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStage("");
    }
  };

  const restart = () => {
    operation.current = null;
    suggested.current = "";
    setCode("");
    setTitle("");
    setSaved(null);
    setError("");
  };

  const guest = account === null;

  return (
    <section
      className={embedded ? "paste-code paste-code--embedded" : "paste-code"}
      id={embedded ? undefined : "paste"}
      ref={card}
      aria-labelledby={embedded ? undefined : "paste-code-title"}
      aria-label={embedded ? "Вставить код артефакта" : undefined}
    >
      {saved ? (
        renderResult(saved, restart)
      ) : (
        <div className="bring-entry paste-code-entry">
          {!embedded && (
            <>
              <div className={titled ? "paste-code-head" : "paste-code-head sr-only"}>
                <h2 id="paste-code-title">Вставить код</h2>
                <Status is="real" />
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
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
          {account && (
            <SelectField
              label="Куда сохранить"
              value={folderId}
              disabled={busy || folders.loading}
              error={folders.error}
              onChange={(e) => {
                setFolderId(e.target.value);
                operation.current = null;
              }}
            >
              <option value="">Моя Полка — без папки</option>
              {folderId && !folders.items.some((f) => f.id === folderId) && (
                <option value={folderId}>
                  {folders.loading ? "Проверяем выбранную папку…" : "Выбранная папка недоступна"}
                </option>
              )}
              {folders.items.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </SelectField>
          )}
          {folders.error && <Button onClick={folders.retry}>Загрузить папки снова</Button>}
          <ErrorNotice error={error} />
          {guest ? (
            <div className="paste-code-login" role="note">
              <p>
                {pasted
                  ? "Код ещё не сохранён и никуда не отправлен. Сохранять можно только на свою Полку — войдите. После входа вернём сюда; код нужно будет вставить ещё раз."
                  : "Сохранение идёт на вашу Полку, поэтому сначала нужен вход. После входа вернём сюда."}
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
            <p className="paste-code-hint" role="status">
              Проверяем вход…
            </p>
          ) : (
            <div className="bring-actions">
              <Button
                type="button"
                variant="primary"
                onClick={save}
                disabled={!pasted || pasted.tooLarge || busy}
              >
                <LockKeyhole />{" "}
                {stage ||
                  (error && operation.current ? "Повторить сохранение" : "Сохранить на Полку")}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
