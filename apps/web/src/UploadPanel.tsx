import React, { useRef, useState } from "react";
import { ArrowUpRight, Upload } from "lucide-react";
import type {
  Artifact,
  Folder,
  Receipt,
} from "../../../packages/contracts/index.ts";
import { MAX_BYTES, MIME } from "../../../packages/contracts/index.ts";
import { client, transfer } from "./client.ts";
import { Dialog, ErrorNotice } from "./ui.tsx";
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
  const operation = useRef<{ file: Blob; id?: string; key: string } | null>(
      null,
    ),
    busy = !!stage;
  const reset = () => {
    operation.current = null;
    setError("");
  };
  const save = async () => {
    setError("");
    const current =
      mode === "file" ? file : new Blob([text], { type: "text/plain" });
    if (!current?.size || !title.trim()) {
      setError("Добавьте название и содержимое.");
      return;
    }
    if (
      !(MIME as readonly string[]).includes(current.type) ||
      current.size > MAX_BYTES
    ) {
      setError(
        "Поддерживаются PNG, JPEG, WebP и текст UTF-8 размером до 5 МБ. HTML пока не поддерживается.",
      );
      return;
    }
    operation.current ??= { file: current, key: crypto.randomUUID() };
    const op = operation.current;
    try {
      setStage("Подготавливаем файл…");
      const sha = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await op.file.arrayBuffer()),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      if (!op.id) {
        const started = await client.begin({
          key: op.key,
          title,
          filename: mode === "file" ? file!.name : `${title}.txt`,
          mime: op.file.type as (typeof MIME)[number],
          size: op.file.size,
          sha256: sha,
          ...(artifact
            ? { artifactId: artifact.id, baseRevisionId: artifact.revision.id }
            : { folderId: folder || null }),
        });
        op.id = started.uploadId;
        if (started.receipt) {
          onSaved(started.receipt);
          return;
        }
      }
      setStage("Передаём файл…");
      await transfer(op.id, op.file);
      setStage("Сохраняем версию…");
      onSaved(await client.finalize(op.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStage("");
    }
  };
  return (
    <Dialog
      title={artifact ? "Добавить новую версию" : "Добавить работу"}
      onClose={onClose}
      busy={busy}
    >
      <div className="dialog-body">
        <p className="muted">
          {artifact
            ? "Текущая ссылка останется прежней. Новую версию можно отправить после просмотра."
            : "Сначала материал виден только вам. Поделиться можно после сохранения."}
        </p>
        <div className="segmented">
          <button
            aria-pressed={mode === "file"}
            onClick={() => {
              setMode("file");
              reset();
            }}
            disabled={busy}
          >
            Загрузить файл
          </button>
          <button
            aria-pressed={mode === "text"}
            onClick={() => {
              setMode("text");
              reset();
            }}
            disabled={busy}
          >
            Вставить текст
          </button>
        </div>
        <label>
          Название
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              reset();
            }}
            maxLength={160}
            disabled={busy}
          />
        </label>
        {mode === "file" ? (
          <label className="file-drop">
            <Upload />
            <strong>{file ? file.name : "Выберите файл"}</strong>
            <span>PNG, JPEG, WebP или TXT · до 5 МБ</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,text/plain,.txt"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ""));
                reset();
              }}
            />
          </label>
        ) : (
          <label>
            Содержимое
            <textarea
              rows={8}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                reset();
              }}
              disabled={busy}
              placeholder="Вставьте заметку, итоги встречи или материал от агента…"
            />
          </label>
        )}
        {!artifact && folders.length > 0 && (
          <label>
            Папка
            <select
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
            </select>
          </label>
        )}
        <p className="fine">
          Интерактивный HTML, PDF и PPTX появятся в следующих срезах. Эта сборка
          их не преобразует.
        </p>
        <ErrorNotice error={error} />
      </div>
      <div className="dialog-footer">
        <button onClick={onClose} disabled={busy}>
          Отмена
        </button>
        <button className="primary" onClick={save} disabled={busy}>
          {stage ||
            (error && operation.current
              ? "Повторить сохранение"
              : "Сохранить на полку")}
          <ArrowUpRight />
        </button>
      </div>
    </Dialog>
  );
}
