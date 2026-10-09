import React, { useEffect, useState } from "react";
import { AppShell } from "../../widgets/navigation/index.tsx";
import { useAccountState } from "../../entities/account/model/useAccount.ts";
import { switchShelf } from "../../entities/shelf/model.ts";
import { ApiError, client } from "../../shared/api/client.ts";
import { Button, LinkButton, Notice } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import {
  parseShelfInvitation,
  parseShelfInvitationFragment,
  type ShelfInvitationLink,
} from "../../shared/lib/shelf-invite.ts";
import "./styles.css";

// The link carries its secret in the fragment. The page moves it to this
// tab's sessionStorage and clears the address, so signing in on the way
// (which leaves and comes back to /shelf-invite) keeps the invitation.
const STORAGE_KEY = "polka:shelf-invite";
function readInvitation(): ShelfInvitationLink | null {
  try {
    if (location.hash) {
      const fromUrl = parseShelfInvitationFragment(location.hash);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      if (!fromUrl) {
        sessionStorage.removeItem(STORAGE_KEY);
        return null;
      }
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fromUrl));
      } catch {
        /* use the in-memory invite */
      }
      return fromUrl;
    }
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as Partial<ShelfInvitationLink>;
    return parseShelfInvitation(parsed.token, parsed.shelfId);
  } catch {
    return null;
  }
}

export function invitationError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Войдите в Полку, чтобы принять приглашение.";
    if (error.status === 403 && /Временная полка/.test(error.message)) return error.message;
    if (error.status === 403) return "Для этого действия войдите через Яндекс ID, VK ID или по почте.";
    if (error.status === 409 && /истёк/.test(error.message))
      return "Срок действия приглашения истёк. Попросите новую ссылку.";
    if (error.status === 409 && /использовано/.test(error.message))
      return "По этой ссылке уже пришли все, кого звали. Попросите новую.";
    if (error.status === 409) return "Приглашение больше не действует. Попросите новую ссылку.";
    if (error.status === 404) return "Приглашение не найдено: его отозвали или ссылка скопирована не целиком.";
  }
  return "Не удалось принять приглашение. Попробуйте ещё раз.";
}

export function ShelfInvite() {
  const { account, error: accountError, retry: retryAccount } = useAccountState();
  // undefined until the link is read: a valid invite must not flash an error.
  const [invitation, setInvitation] = useState<ShelfInvitationLink | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // oxlint-disable-next-line react/set-state-in-effect -- read once after mount: it clears the address and fills sessionStorage, which a render must not do
  useEffect(() => setInvitation(readInvitation()), []);
  async function accept() {
    if (!invitation || busy) return;
    setBusy(true);
    setError("");
    try {
      const joined = await client.acceptShelfInvitation(invitation.shelfId, invitation.token);
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* nothing was stored */
      }
      switchShelf(joined.shelfId);
    } catch (e) {
      setError(invitationError(e));
      setBusy(false);
    }
  }
  return (
    <AppShell current="shelf" account={account}>
      <main className="shelf-invite-page">
        <span className="eyebrow">Полка отдела</span>
        <h1>Вас пригласили на полку отдела</h1>
        {invitation === undefined ? null : !invitation ? (
          <ErrorNotice error="Ссылка приглашения неполная или уже недоступна." />
        ) : account === undefined ? (
          accountError ? (
            <>
              <ErrorNotice error={`Не удалось проверить аккаунт. ${accountError}`} />
              <Button onClick={retryAccount}>Проверить снова</Button>
            </>
          ) : (
            <p role="status">Проверяем аккаунт…</p>
          )
        ) : account === null ? (
          <>
            <p>Войдите или заведите аккаунт — после входа вы вернётесь сюда и примете приглашение.</p>
            <LinkButton variant="primary" href="/?login=1&next=%2Fshelf-invite">
              Войти и продолжить
            </LinkButton>
          </>
        ) : (
          <>
            <p>
              Работы на полке отдела видят все её участники. Роль назначил тот, кто прислал ссылку; потом её может
              поменять администратор полки.
            </p>
            {error && <Notice tone="error">{error}</Notice>}
            <Button variant="primary" busy={busy} onClick={accept}>
              Принять приглашение
            </Button>
            <p className="fine">
              Вы вошли как {account.name}. Если это не тот аккаунт, выйдите и откройте ссылку снова.
            </p>
          </>
        )}
      </main>
    </AppShell>
  );
}
