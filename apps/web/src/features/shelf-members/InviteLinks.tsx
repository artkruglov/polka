import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link2 } from "lucide-react";
import { client, type ShelfDirectAdd, type ShelfInvitation } from "../../shared/api/client.ts";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { Button, SelectField } from "../../shared/ui/controls.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import { ROLE_HINT, ROLE_LABEL } from "../../entities/shelf/model.ts";

type InviteRole = ShelfInvitation["role"];
type Inviter = "admin" | "curator";

/** The roles a link may carry: never admin; a curator invites readers and authors. */
export const inviteRoles = (inviter: Inviter): InviteRole[] =>
  inviter === "admin" ? ["reader", "author", "curator"] : ["reader", "author"];

export const EXPIRY_CHOICES = [
  { hours: 24, label: "сутки" },
  { hours: 72, label: "3 дня" },
  { hours: 168, label: "неделю" },
] as const;
export const USES_CHOICES = [
  { uses: 1, label: "один человек" },
  { uses: 10, label: "до 10 человек" },
  { uses: 50, label: "до 50 человек" },
] as const;

const STATUS: Record<ShelfInvitation["status"], string> = {
  active: "действует",
  used: "все пришли",
  expired: "срок истёк",
  revoked: "отозвана",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

/** One line about a link: role, who may still come, until when. */
export function invitationSummary(item: ShelfInvitation) {
  const role = ROLE_LABEL[item.role].toLowerCase();
  const people = item.maxUses === 1 ? "для одного" : `пришли ${item.uses} из ${item.maxUses}`;
  const state = item.status === "active" ? `до ${when(item.expiresAt)}` : STATUS[item.status];
  return `${role} · ${people} · ${state}`;
}

/**
 * Whom a link is for. With the organisation rule (TEAM_SHELVES_SCOPE=organisation)
 * only its staff with a verified work address are added directly, so a link
 * is also for people who have signed in already.
 */
export function inviteAudience(directAdd: ShelfDirectAdd = { scope: "installation" }) {
  return directAdd.scope === "installation"
    ? "Для тех, кто ещё ни разу не входил в Полку."
    : "Для всех, кого нельзя добавить сразу: кто ещё не входил в Полку, у кого нет подтверждённой рабочей почты или кто не из вашей организации.";
}

/**
 * The form and the list, without loading: what the panel shows and the
 * render test checks.
 */
export function InviteLinksView({
  inviter,
  accountId,
  directAdd,
  items,
  created,
  busy,
  error,
  onCreate,
  onRevoke,
}: {
  inviter: Inviter;
  accountId: string;
  directAdd?: ShelfDirectAdd;
  items: ShelfInvitation[] | null;
  created: { id: string; url: string; summary: string } | null;
  busy: boolean;
  error: string;
  onCreate: (input: { role: InviteRole; expiresInHours: number; maxUses: number }) => void;
  onRevoke: (item: ShelfInvitation) => void;
}) {
  const roles = inviteRoles(inviter);
  const [role, setRole] = useState<InviteRole>("author"),
    [hours, setHours] = useState<number>(72),
    [uses, setUses] = useState<number>(1);
  const active = (items ?? []).filter((item) => item.status === "active");
  return (
    <section className="shelf-invite-links" aria-label="Приглашение ссылкой">
      <h3>Пригласить ссылкой</h3>
      <p className="shelf-members-lead">
        {inviteAudience(directAdd)} Отправьте ссылку в рабочий чат: кто откроет её и войдёт, окажется на полке с
        выбранной ролью.
        {inviter === "curator" && " Кураторов приглашает администратор."}
      </p>
      <form
        className="shelf-invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({ role, expiresInHours: hours, maxUses: uses });
        }}
      >
        <SelectField
          label="Роль"
          value={role}
          disabled={busy}
          onChange={(event) => setRole(event.target.value as InviteRole)}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]} — {ROLE_HINT[r]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Действует"
          value={hours}
          disabled={busy}
          onChange={(event) => setHours(Number(event.target.value))}
        >
          {EXPIRY_CHOICES.map((choice) => (
            <option key={choice.hours} value={choice.hours}>
              {choice.label}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Для кого"
          value={uses}
          disabled={busy}
          onChange={(event) => setUses(Number(event.target.value))}
        >
          {USES_CHOICES.map((choice) => (
            <option key={choice.uses} value={choice.uses}>
              {choice.label}
            </option>
          ))}
        </SelectField>
        <Button type="submit" busy={busy}>
          <Link2 /> Создать ссылку
        </Button>
      </form>
      {created && (
        <div className="shelf-invite-created" role="status">
          <p>Ссылка готова: {created.summary}. Скопируйте её сейчас — второй раз Полка её не покажет.</p>
          <code>{created.url}</code>
          <CopyButton value={created.url} label="Скопировать ссылку" />
        </div>
      )}
      <ErrorNotice error={error} />
      {items === null ? (
        <p className="shelf-members-lead" role="status">
          Загружаем приглашения…
        </p>
      ) : (
        active.length > 0 && (
          <ul className="shelf-invite-list" aria-label="Действующие приглашения">
            {active.map((item) => (
              <li key={item.id}>
                <span>
                  {invitationSummary(item)}
                  {item.inviterName && <small>автор ссылки: {item.inviterName}</small>}
                </span>
                {(inviter === "admin" || item.invitedBy === accountId) && (
                  <Button variant="quiet" disabled={busy} onClick={() => onRevoke(item)}>
                    Отозвать
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}

/** Invitation links on the shelf's members dialog, for its admin and curators. */
export function ShelfInviteLinks({
  shelfId,
  inviter,
  accountId,
  directAdd,
  onCreated,
}: {
  shelfId: string;
  inviter: Inviter;
  accountId: string;
  directAdd?: ShelfDirectAdd;
  /** A link is ready: the panel drops the direct-add error it answered. */
  onCreated?: () => void;
}) {
  const [items, setItems] = useState<ShelfInvitation[] | null>(null),
    [created, setCreated] = useState<{ id: string; url: string; summary: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = useRef(true);
  const reload = useCallback(async () => {
    const page = await client.shelfInvitations(shelfId);
    if (live.current) setItems(page.items);
  }, [shelfId]);
  useEffect(() => {
    live.current = true;
    reload().catch((e) => live.current && setError((e as Error).message));
    return () => {
      live.current = false;
    };
  }, [shelfId, reload]);
  const act = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      await reload();
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <InviteLinksView
      inviter={inviter}
      accountId={accountId}
      directAdd={directAdd}
      items={items}
      created={created}
      busy={busy}
      error={error}
      onCreate={(input) =>
        void act(async () => {
          const link = await client.createShelfInvitation(shelfId, input);
          if (!live.current) return;
          setCreated({ id: link.id, url: link.invitationUrl, summary: invitationSummary(link) });
          onCreated?.();
        })
      }
      onRevoke={(item) =>
        void act(async () => {
          await client.revokeShelfInvitation(shelfId, item.id);
          if (live.current) setCreated((shown) => (shown?.id === item.id ? null : shown));
        })
      }
    />
  );
}
