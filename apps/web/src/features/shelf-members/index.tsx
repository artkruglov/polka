import React, { useEffect, useRef, useState } from "react";
import { Building2, ChevronsUpDown, Home, Plus, UserMinus, UserPlus, Users } from "lucide-react";
import { ActionMenu } from "../../shared/ui/ActionMenu.tsx";
import {
  client,
  type Shelf,
  type ShelfMember,
} from "../../shared/api/client.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { Avatar, Button, SelectField, TextField } from "../../shared/ui/controls.tsx";
import { ROLE_HINT, ROLE_LABEL, loadShelves, switchShelf } from "../../entities/shelf/model.ts";
import "./styles.css";

type TeamRole = ShelfMember["role"];
const ROLES: TeamRole[] = ["reader", "author", "curator", "admin"];

/** A company admin opens a department shelf (docs/specs/TEAM_SHELVES.md). */
export function CreateShelfPanel({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError("Назовите полку.");
    setBusy(true);
    setError("");
    try {
      const shelf = await client.createShelf(name.trim());
      switchShelf(shelf.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog title="Новая полка отдела" busy={busy} onClose={() => !busy && onClose()}>
      <form onSubmit={submit}>
        <div className="dialog-body">
          <p className="shelf-members-lead">
            Общее место для работ отдела. Вы станете её администратором и добавите коллег.
          </p>
          <TextField
            label="Название"
            placeholder="Отдел продаж"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoFocus
            disabled={busy}
          />
          <ErrorNotice error={error} />
        </div>
        <div className="dialog-footer">
          <Button onClick={onClose} disabled={busy}>Отмена</Button>
          <Button variant="primary" type="submit" busy={busy}>Создать полку</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Who is on a department shelf and with which role. Everyone sees the list;
 * its admin adds colleagues, changes roles, removes members and renames the
 * shelf; anyone may leave.
 */
export function ShelfMembersPanel({
  shelf,
  accountId,
  onClose,
}: {
  shelf: Shelf;
  accountId: string;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<ShelfMember[] | null>(null),
    [role, setRole] = useState(shelf.role),
    [who, setWho] = useState(""),
    [newRole, setNewRole] = useState<TeamRole>("author"),
    [name, setName] = useState(shelf.name ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const live = useRef(true);
  const admin = role === "admin";

  const reload = async () => {
    const page = await client.shelfMembers(shelf.id);
    if (!live.current) return;
    setMembers(page.items);
    setRole(page.role);
  };
  useEffect(() => {
    live.current = true;
    reload().catch((e) => live.current && setError((e as Error).message));
    return () => {
      live.current = false;
    };
  }, [shelf.id]);

  const act = async (work: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await reload();
      if (done && live.current) setNotice(done);
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const [leaving, setLeaving] = useState(false);
  const leave = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await client.revokeShelfMember(shelf.id, accountId);
      await loadShelves(true);
      switchShelf(null);
    } catch (e) {
      if (live.current) {
        setError((e as Error).message);
        setBusy(false);
        setLeaving(false);
      }
    }
  };

  return (
    <Dialog title={`Участники · ${shelf.name ?? "полка отдела"}`} busy={busy} onClose={() => !busy && onClose()}>
      <div className="dialog-body shelf-members">
        {admin && (
          <form
            className="shelf-members-rename"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && name.trim() !== shelf.name)
                void act(async () => {
                  await client.renameShelf(shelf.id, name.trim());
                  location.reload();
                });
            }}
          >
            <TextField
              label="Название полки"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
            <Button type="submit" disabled={busy || !name.trim() || name.trim() === shelf.name}>
              Переименовать
            </Button>
          </form>
        )}
        {admin && (
          <form
            className="shelf-members-add"
            onSubmit={(event) => {
              event.preventDefault();
              if (!who.trim()) return setError("Укажите почту или логин коллеги.");
              void act(async () => {
                const added = await client.addShelfMember(shelf.id, who.trim(), newRole);
                setWho("");
                setNotice(`${added.name} добавлен: ${ROLE_LABEL[added.role].toLowerCase()}.`);
              });
            }}
          >
            <TextField
              label="Почта или логин коллеги"
              hint="Коллега должен хотя бы раз войти в Полку."
              value={who}
              onChange={(event) => setWho(event.target.value)}
              disabled={busy}
              autoComplete="off"
            />
            <SelectField
              label="Роль"
              value={newRole}
              onChange={(event) => setNewRole(event.target.value as TeamRole)}
              disabled={busy}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]} — {ROLE_HINT[r]}
                </option>
              ))}
            </SelectField>
            <Button type="submit" variant="primary" busy={busy}>
              <UserPlus /> Добавить
            </Button>
          </form>
        )}
        {notice && <p className="shelf-members-notice" role="status">{notice}</p>}
        <ErrorNotice error={error} />
        {members === null ? (
          <p className="shelf-members-lead" role="status">Загружаем участников…</p>
        ) : (
          <ul className="shelf-members-list" aria-label="Участники полки">
            {members.map((member) => (
              <li key={member.accountId}>
                <Avatar name={member.name} size="sm" />
                <span className="shelf-members-name">
                  {member.name}
                  {member.accountId === accountId && <small> (вы)</small>}
                  {member.email && <small>{member.email}</small>}
                </span>
                {admin ? (
                  <select
                    className="ui-input shelf-members-role"
                    aria-label={`Роль: ${member.name}`}
                    value={member.role}
                    disabled={busy}
                    onChange={(event) =>
                      void act(
                        () => client.changeShelfMemberRole(shelf.id, member.accountId, event.target.value as TeamRole),
                        `${member.name}: ${ROLE_LABEL[event.target.value as TeamRole].toLowerCase()}.`,
                      )
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                ) : (
                  <span className="shelf-members-role">{ROLE_LABEL[member.role]}</span>
                )}
                {admin && member.accountId !== accountId && (
                  <Button
                    variant="quiet"
                    aria-label={`Убрать с полки: ${member.name}`}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => client.revokeShelfMember(shelf.id, member.accountId),
                        `${member.name} больше не на полке. Его работы остались.`,
                      )
                    }
                  >
                    <UserMinus />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="dialog-footer">
        {leaving ? (
          <span className="shelf-members-confirm">
            Ваши агенты на этой полке отключатся.{" "}
            <Button variant="quiet" className="shelf-members-leave" busy={busy} onClick={() => void leave()}>
              Да, покинуть
            </Button>
            <Button variant="quiet" disabled={busy} onClick={() => setLeaving(false)}>
              Остаться
            </Button>
          </span>
        ) : (
          <Button variant="quiet" className="shelf-members-leave" disabled={busy} onClick={() => setLeaving(true)}>
            Покинуть полку
          </Button>
        )}
        <Button variant="primary" onClick={onClose} disabled={busy}>Готово</Button>
      </div>
    </Dialog>
  );
}

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
          { id: "company", label: "Полки компании", icon: <Building2 />, onSelect: () => location.assign("/settings/company") },
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
