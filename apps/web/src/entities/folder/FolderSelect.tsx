import React from "react";
import { Button, SelectField } from "../../shared/ui/controls.tsx";
import type { useFolders } from "./useFolders.ts";

/**
 * «Куда сохранить» for every save form. A folder chosen earlier (from the URL)
 * stays selectable while folders load, and is named as unavailable if it is gone.
 */
export function FolderSelect({
  folders,
  value,
  onChange,
  disabled = false,
  hint,
}: {
  folders: ReturnType<typeof useFolders>;
  value: string;
  onChange: (folderId: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <>
      <SelectField
        label="Куда сохранить"
        value={value}
        disabled={disabled || folders.loading}
        hint={folders.loading ? "Загружаем папки…" : hint}
        error={folders.error}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Моя полка — без папки</option>
        {value && !folders.items.some((f) => f.id === value) && (
          <option value={value}>
            {folders.loading
              ? "Проверяем выбранную папку…"
              : "Выбранная папка недоступна"}
          </option>
        )}
        {folders.items.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </SelectField>
      {folders.error && (
        <Button onClick={folders.retry}>Загрузить папки снова</Button>
      )}
    </>
  );
}
