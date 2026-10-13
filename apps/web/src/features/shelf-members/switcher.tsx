import React from "react";
import { Building2, ChevronsUpDown, Home, Plus, Users } from "lucide-react";
import { ActionMenu } from "../../shared/ui/ActionMenu.tsx";
import type { Shelf } from "../../shared/api/client.ts";
import { ROLE_LABEL, switchShelf } from "../../entities/shelf/model.ts";
import "./styles.css";

// Apart from the dialogs (index.tsx): the workspace shows the switcher on
// every screen and loads the dialogs only when one opens.
/**
 * Which shelf the rail shows: the account's own or a department's. Shown
 * once the account belongs to a department shelf or may open one.
 */
export function ShelfSwitcher({
  shelves,
  current,
  canCreate,
  onCreate,
  onMembers,
}: {
  shelves: Shelf[];
  current: Shelf | null;
  canCreate: boolean;
  onCreate: () => void;
  onMembers: () => void;
}) {
  if (!current || (shelves.length < 2 && !canCreate)) return null;
  const items = [
    ...shelves.map((shelf) => ({
      id: shelf.id,
      label: `${shelf.kind === "personal" ? "Моя полка" : shelf.name}${shelf.id === current.id ? " · открыта" : ""}`,
      icon: shelf.kind === "personal" ? <Home /> : <Users />,
      onSelect: () => {
        if (shelf.id !== current.id) switchShelf(shelf.kind === "personal" ? null : shelf.id);
      },
    })),
    ...(current.kind === "team"
      ? [{ id: "members", label: "Участники полки", icon: <Users />, onSelect: onMembers }]
      : []),
    ...(canCreate
      ? [
          { id: "create", label: "Новая полка отдела", icon: <Plus />, onSelect: onCreate },
          // The company admin's page (docs/specs/TEAM_SHELVES.md, stage 4).
          {
            id: "company",
            label: "Полки компании",
            icon: <Building2 />,
            onSelect: () => location.assign("/settings/company"),
          },
        ]
      : []),
  ];
  return (
    <div className="shelf-switcher">
      <ActionMenu
        label={`Полка: ${current.kind === "personal" ? "моя" : current.name}. Сменить`}
        placement="start"
        items={items}
        icon={
          <span className="shelf-switcher-trigger">
            {current.kind === "personal" ? <Home aria-hidden="true" /> : <Users aria-hidden="true" />}
            <span>{current.kind === "personal" ? "Моя полка" : current.name}</span>
            <ChevronsUpDown aria-hidden="true" />
          </span>
        }
      />
      {current.kind === "team" && (
        <small className="shelf-switcher-role">Вы — {ROLE_LABEL[current.role].toLowerCase()}</small>
      )}
    </div>
  );
}
