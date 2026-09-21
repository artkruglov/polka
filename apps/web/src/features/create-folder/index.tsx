import React, { useRef, useState } from "react";
import type { Folder } from "../../../../../packages/contracts/index.ts";
import { client, ApiError } from "../../shared/api/client.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { Button, TextField } from "../../shared/ui/controls.tsx";
export function CreateFolderPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (folder: Folder) => void;
}) {
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const saving = useRef(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving.current) return;
    if (!name.trim()) {
      setError("Введите название папки.");
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const folder = await client.createFolder(name.trim());
      onCreated(folder);
    } catch (error) {
      setError(
        error instanceof ApiError && error.status === 409
          ? "Папка с таким названием уже есть. Выберите другое."
          : error instanceof Error
          ? error.message
          : "Не удалось создать папку. Попробуйте ещё раз.",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Новая папка"
      busy={busy}
      onClose={() => {
        if (!saving.current) onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="dialog-body">
          <TextField
            label="Название папки"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={80}
            autoFocus
            disabled={busy}
          />
          <ErrorNotice error={error} />
        </div>
        <div className="dialog-footer">
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" busy={busy}>
            Создать папку
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
