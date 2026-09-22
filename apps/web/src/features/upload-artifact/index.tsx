import { Button, TextAreaField, TextField, SelectField } from "../../shared/ui/controls.tsx";
import React, { useRef, useState } from "react";
import { ArrowUpRight, Upload } from "lucide-react";
import type {
  Artifact,
  Folder,
  Receipt,
} from "../../../../../packages/contracts/index.ts";
import { MAX_BYTES, MIME } from "../../../../../packages/contracts/index.ts";
import {
  fileMime,
  saveUpload,
  type PendingUpload,
} from "../../shared/api/client.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { fallbackTitle, suggestTitle } from "../../entities/artifact/html-title.ts";
export function UploadPanel({
  artifact,
  folders,
  folderId,
  onClose,
  onSaved,
}: {
  artifact?: Artifact;
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
    [stage, setStage] = useState("");
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
        ? file && new Blob([file], { type: fileMime(file) })
        : new Blob([text], { type: "text/plain" });
    if (!current?.size || !title.trim()) {
      setError("Добавьте название и содержимое.");
      return;
    }
    if (
      !(MIME as readonly string[]).includes(current.type) ||
      current.size > MAX_BYTES
    ) {
      setError(
        "Поддерживаются HTML, PNG, JPEG, WebP и текст UTF-8 размером до 5 МБ. ZIP и PDF пока не поддерживаются.",
      );
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
        <div className="segmented">
          <Button
            aria-pressed={mode === "file"}
            onClick={() => {
              setMode("file");
              reset();
            }}
            disabled={busy}
          >
            Загрузить файл
          </Button>
          <Button
            aria-pressed={mode === "text"}
            onClick={() => {
              setMode("text");
              reset();
            }}
            disabled={busy}
          >
            Вставить текст
          </Button>
        </div>
        <TextField label="Название"
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
            <span>HTML, PNG, JPEG, WebP или TXT · до 5 МБ</span>
            <input
              type="file"
              accept="text/html,.html,.htm,image/png,image/jpeg,image/webp,text/plain,.txt"
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
          <SelectField
            label="Папка"
            value={folder}
            onChange={(e) => {
              setFolder(e.target.value);
              reset();
            }}
            disabled={busy}
          >
            <option value="">На моей полке</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </SelectField>
        )}
        <p className="fine">
          Сначала показываем сохранённый вид HTML. Доступность отдельного
          интерактивного режима и ссылки определяется после сохранения. ZIP, PDF
          и PPTX эта сборка не принимает.
        </p>
        <ErrorNotice error={error} />
      </div>
      <div className="dialog-footer">
        <Button onClick={onClose} disabled={busy}>
          Отмена
        </Button>
        <Button variant="primary" onClick={save} disabled={busy}>
          {stage ||
            (error && operation.current
              ? "Повторить сохранение"
              : "Сохранить на полку")}
          <ArrowUpRight />
        </Button>
      </div>
    </Dialog>
  );
}
