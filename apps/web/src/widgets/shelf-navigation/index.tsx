import React from "react";
import { Folder as FolderIcon, Plus, Trash2 } from "lucide-react";
import type { Folder } from "../../../../../packages/contracts/index.ts";
import { IconButton } from "../../shared/ui/controls.tsx";
import { withShelf } from "../../shared/api/client.ts";
/** Folders and the trash: the page-owned part of the rail. */
export function ShelfNavigation({
  folders,
  folderId,
  trashView,
  onCreateFolder,
  onOpenFolder,
  onOpenTrash,
  canCreateFolder = true,
}: {
  folders: Folder[];
  folderId: string | null;
  trashView: boolean;
  onCreateFolder: () => void;
  onOpenFolder: (id: string) => void;
  onOpenTrash: () => void;
  /** Folders on a department shelf are a curator's. */
  canCreateFolder?: boolean;
}) {
  return (
    <>
      <div className="nav-label">
        Папки
        {canCreateFolder && (
          <IconButton size="sm" label="Создать папку" onClick={onCreateFolder}>
            <Plus />
          </IconButton>
        )}
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
          <span>{f.name}</span>
        </a>
      ))}
      {!folders.length && (
        <p className="shelf-nav-hint">Соберите работы по проектам и темам.</p>
      )}
      <div className="shelf-nav-secondary">
        <a
          className={trashView ? "nav-link active" : "nav-link"}
          href={withShelf("/trash")}
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
