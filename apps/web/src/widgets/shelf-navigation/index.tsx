import React from "react";
import { Folder as FolderIcon, Plus, Trash2 } from "lucide-react";
import type { Folder } from "../../../../../packages/contracts/index.ts";
import { Button } from "../../shared/ui/controls.tsx";
export function ShelfNavigation({
  folders,
  folderId,
  trashView,
  onCreateFolder,
  onOpenFolder,
  onOpenTrash,
}: {
  folders: Folder[];
  folderId: string | null;
  trashView: boolean;
  onCreateFolder: () => void;
  onOpenFolder: (id: string) => void;
  onOpenTrash: () => void;
}) {
  return (
    <>
      <div className="nav-label">
        ПАПКИ
        <Button
          variant="quiet"
          className="icon small"
          aria-label="Создать папку"
          onClick={() => {
            onCreateFolder();
          }}
        >
          <Plus />
        </Button>
      </div>
      {folders.map((f) => (
        <a
          href="/"
          key={f.id}
          className={
            folderId === f.id && !trashView ? "nav-link active" : "nav-link"
          }
          aria-current={folderId === f.id && !trashView ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            onOpenFolder(f.id);
          }}
        >
          <FolderIcon />
          {f.name}
        </a>
      ))}
      {!folders.length && (
        <p className="shelf-nav-hint">Соберите работы по проектам и темам.</p>
      )}
      <div className="shelf-nav-secondary">
        <a className="nav-link" href="/templates"><FolderIcon />Шаблоны</a>
        <a
          className={trashView ? "nav-link active" : "nav-link"}
          href="/trash"
          aria-current={trashView ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            onOpenTrash();
          }}
        >
          <Trash2 />
          Корзина
        </a>
      </div>
    </>
  );
}
