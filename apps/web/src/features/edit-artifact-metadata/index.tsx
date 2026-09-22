import React, { useEffect, useState } from "react";
import type {
  Artifact,
  Folder,
} from "../../../../../packages/contracts/index.ts";
import { ApiError, client } from "../../shared/api/client.ts";
import { Button, TextField, SelectField } from "../../shared/ui/controls.tsx";
import { Dialog } from "../../shared/ui/index.tsx";

export function ArtifactMetadataPanel({
  artifact,
  folders,
  onClose,
  onSaved,
  onReload,
}: {
  artifact: Artifact;
  folders: Folder[];
  onClose: () => void;
  onSaved: (artifact: Artifact) => Promise<void> | void;
  onReload: () => Promise<Artifact | null>;
}) {
  const [title, setTitle] = useState(artifact.title);
  const [folderId, setFolderId] = useState<string | null>(artifact.folderId);
  const [expectedTitle, setExpectedTitle] = useState(artifact.title);
  const [expectedFolderId, setExpectedFolderId] = useState<string | null>(
    artifact.folderId,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    setTitle(artifact.title);
    setFolderId(artifact.folderId);
    setExpectedTitle(artifact.title);
    setExpectedFolderId(artifact.folderId);
    setError("");
    setConflict(false);
    // A refreshed snapshot updates the expected values explicitly below; keep the
    // user draft while resolving a conflict on the same artifact.
  }, [artifact.id]);

  const reloadSnapshot = async () => {
    setBusy(true);
    try {
      const fresh = await onReload();
      if (fresh) {
        setExpectedTitle(fresh.title);
        setExpectedFolderId(fresh.folderId);
        setConflict(false);
        setError(
          "Данные обновлены. Проверьте введённые поля и повторите сохранение.",
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось обновить данные.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError("Введите название работы.");
      return;
    }
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const updated = await client.updateArtifactMetadata(artifact.id, {
        title: nextTitle,
        folderId,
        expectedTitle,
        expectedFolderId,
      });
      await onSaved(updated);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true);
        setError(
          "Работа изменилась. Обновите данные и повторите сохранение. Введённые поля сохранены.",
        );
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось сохранить изменения.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Название и папка"
      onClose={() => {
        if (!busy) onClose();
      }}
      busy={busy}
    >
      <form onSubmit={submit}>
        <div className="dialog-body artifact-metadata-form">
          <TextField
            label="Название"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={160}
            autoFocus
            required
          />
          <SelectField
            label="Папка"
            value={folderId ?? ""}
            onChange={(event) => setFolderId(event.target.value || null)}
          >
            <option value="">Без папки</option>
            {folders.map((folder) => (
              <option value={folder.id} key={folder.id}>
                {folder.name}
              </option>
            ))}
          </SelectField>
          {error && (
            <p
              className={conflict ? "ui-field-hint" : "ui-field-error"}
              role="alert"
            >
              {error}
            </p>
          )}
          {conflict && (
            <Button
              type="button"
              onClick={() => void reloadSnapshot()}
              disabled={busy}
            >
              Обновить данные
            </Button>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
