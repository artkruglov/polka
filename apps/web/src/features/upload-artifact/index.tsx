import { Button, Segmented, TextAreaField, TextField } from "../../shared/ui/controls.tsx";
import { CopyText } from "../../shared/ui/CopyText.tsx";
import { updatePhrase } from "../../entities/artifact/agent-phrases.ts";
import React, { useRef, useState } from "react";
import { ArrowUpRight, Upload } from "lucide-react";
import type {
  Artifact,
  Folder,
  Receipt,
} from "../../../../../packages/contracts/index.ts";
import { saveUpload, type PendingUpload } from "../../shared/api/client.ts";
import {
  UPLOAD_ACCEPT,
  UPLOAD_FORMATS,
  uploadBlob,
  uploadProblem,
} from "../../entities/artifact/upload.ts";
import { FolderSelect } from "../../entities/folder/FolderSelect.tsx";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { fallbackTitle, suggestTitle } from "../../entities/artifact/html-title.ts";
export function UploadPanel({
  artifact,
  shelfUrl,
  folders,
  folderId,
  onClose,
  onSaved,
}: {
  artifact?: Artifact;
  /** The work's page (a new version): named in the phrase for the agent. */
  shelfUrl?: string;
  folders: Folder[];
  folderId: string | null;
  onClose: () => void;
  onSaved: (r: Receipt) => void;
}) {
  const [mode, setMode] = useState<"file" | "text">("file"),
    [title, setTitle] = useState(artifact?.title ?? ""),
    [file, setFile] = useState<File | null>(null),
    [text, setText] = useState(""),
    [folder, setFolder] = useState(folderId ?? ""),
    [error, setError] = useState(""),
    [stage, setStage] = useState(""),
    // A new version: the agent phrase leads; the file and text forms fold away.
    [manual, setManual] = useState(!artifact);
  const operation = useRef<PendingUpload | null>(null),
    busy = !!stage;
  const reset = () => {
    operation.current = null;
    setError("");
  };
  const save = async () => {
    setError("");
    const current =
      mode === "file"
        ? file && uploadBlob(file)
        : new Blob([text], { type: "text/plain" });
    if (!current?.size || !title.trim()) {
      setError("Добавьте название и содержимое.");
      return;
    }
    const problem = uploadProblem(current);
    if (problem) {
      setError(problem);
      return;
    }
    operation.current ??= { file: current, key: crypto.randomUUID() };
    try {
      onSaved(
        await saveUpload(
          operation.current,
          {
            title,
            filename: mode === "file" ? file!.name : `${title}.txt`,
            ...(artifact
              ? {
                  artifactId: artifact.id,
                  baseRevisionId: artifact.revision.id,
                }
              : { folderId: folder || null }),
          },
          setStage,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStage("");
    }
  };
  return (
    <Dialog
      title={
        artifact ? "Сохранить новую версию" : "Сохранить работу с компьютера"
      }
      onClose={onClose}
      busy={busy}
    >
      <div className="dialog-body">
        <p className="muted">
          {artifact
            ? "Отправленная ссылка останется на прежней версии. Обновить её можно отдельно после просмотра."
            : "Сначала работу видите только вы. Поделиться ссылкой можно после сохранения."}
        </p>
        {artifact && (
          <section className="upload-agent">
            <h3>Попросите агента</h3>
            <CopyText
              label="Фраза для агента"
              value={updatePhrase(artifact.title, shelfUrl ?? "")}
              rows={3}
              buttonVariant="primary"
              buttonLabel="Скопировать фразу"
              successText="Скопировано. Вставьте в чат агента"
            />
            <p className="fine">
              Агент найдёт работу по адресу, внесёт правки и сохранит новую версию сам.
            </p>
          </section>
        )}
        {artifact && (
          <details
            className="upload-manual"
            open={manual}
            onToggle={(event) => setManual(event.currentTarget.open)}
          >
            <summary>Загрузить файл или вставить текст</summary>
          </details>
        )}
        {manual && (<>
        <Segmented
          label="Что сохранить"
          value={mode}
          onChange={(next) => {
            if (busy) return;
            setMode(next);
            reset();
          }}
          options={[
            { id: "file", label: "Загрузить файл" },
            { id: "text", label: "Вставить текст" },
          ]}
          wide
        />
        <TextField
          label="Название"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            reset();
          }}
          maxLength={160}
          disabled={busy}
        />
        {mode === "file" ? (
          <label className="file-drop">
            <Upload />
            <strong>{file ? file.name : "Выберите файл"}</strong>
            <span>{UPLOAD_FORMATS}</span>
            <input
              type="file"
              accept={UPLOAD_ACCEPT}
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !title) {
                  const fallback = fallbackTitle(f);
                  setTitle(fallback);
                  void suggestTitle(f).then((suggested) =>
                    setTitle((current) => (current === fallback ? suggested : current)),
                  );
                }
                reset();
              }}
            />
          </label>
        ) : (
          <TextAreaField
            label="Содержимое"
            rows={8}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              reset();
            }}
            disabled={busy}
            placeholder="Вставьте текст, который собрал агент…"
          />
        )}
        {!artifact && folders.length > 0 && (
          <FolderSelect
            folders={{ items: folders, loading: false, error: "", retry: () => {} }}
            value={folder}
            onChange={(next) => {
              setFolder(next);
              reset();
            }}
            disabled={busy}
          />
        )}
        <p className="fine">
          Сначала показываем сохранённый вид HTML. Доступность отдельного
          интерактивного режима и ссылки определяется после сохранения. ZIP, PDF
          и PPTX эта сборка не принимает.
        </p>
        <ErrorNotice error={error} />
        </>)}
      </div>
      <div className="dialog-footer">
        <Button onClick={onClose} disabled={busy}>
          {manual ? "Отмена" : "Закрыть"}
        </Button>
        {manual && (
          <Button variant="primary" onClick={save} disabled={busy}>
            {stage ||
              (error && operation.current
                ? "Повторить сохранение"
                : "Сохранить на полку")}
            <ArrowUpRight />
          </Button>
        )}
      </div>
    </Dialog>
  );
}
