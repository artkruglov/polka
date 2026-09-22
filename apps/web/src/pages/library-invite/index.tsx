import React, { useEffect, useState } from "react";
import { AppShell } from "../../widgets/navigation/index.tsx";
import { useAccountState } from "../../entities/account/model/useAccount.ts";
import { ApiError, request } from "../../shared/api/client.ts";
import { Button, LinkButton, Notice } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { parseLibraryInvitation, parseLibraryInvitationFragment, type LibraryInvitation } from "../../shared/lib/library-invite.ts";
import "./styles.css";

const STORAGE_KEY = "polka:library-invite";
function readInvitation(): LibraryInvitation | null {
  try {
    if (location.hash) {
      const fromUrl = parseLibraryInvitationFragment(location.hash);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      if (!fromUrl) {
        sessionStorage.removeItem(STORAGE_KEY);
        return null;
      }
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fromUrl)); } catch { /* use the in-memory invite */ }
      return fromUrl;
    }
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as Partial<LibraryInvitation>;
    return parseLibraryInvitation(parsed.token, parsed.libraryId);
  } catch {
    return null;
  }
}

function invitationError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Войдите в аккаунт, чтобы принять приглашение.";
    if (error.status === 403 && /Сначала подтвердите/i.test(error.message))
      return "Сначала подтвердите адрес электронной почты аккаунта. Это приглашение не меняет статус подтверждения.";
    if (error.status === 403) return "Приглашение предназначено для другого подтверждённого адреса.";
    if (error.status === 409 && /истёк/i.test(error.message)) return "Срок действия приглашения истёк.";
    if (error.status === 409) return "Приглашение уже недействительно или доступ был отозван.";
    if (error.status === 404) return "Приглашение не найдено или уже недействительно.";
  }
  return "Не удалось принять приглашение. Попробуйте ещё раз.";
}

export function LibraryInvite() {
  const { account, error: accountError, retry: retryAccount } = useAccountState();
  // undefined until the link is read: a valid invite must not flash an error.
  const [invitation, setInvitation] = useState<LibraryInvitation | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setInvitation(readInvitation()), []);
  async function accept() {
    if (!invitation || busy) return;
    setBusy(true); setError("");
    try {
      await request(`/template-libraries/${invitation.libraryId}/invitations/accept`, { token: invitation.token });
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* nothing was stored */ }
      location.assign(`/templates?libraryId=${encodeURIComponent(invitation.libraryId)}`);
    } catch (e) {
      setError(invitationError(e));
    } finally { setBusy(false); }
  }
  return <AppShell current="templates" account={account}>
    <main className="library-invite-page">
      <span className="eyebrow">Общая библиотека</span>
      <h1>Приглашение в библиотеку</h1>
      {invitation === undefined ? null : !invitation ? <ErrorNotice error="Ссылка приглашения неполная или уже недоступна." /> : account === undefined ? (accountError ?
        <><ErrorNotice error={`Не удалось проверить аккаунт. ${accountError}`} /><Button onClick={retryAccount}>Проверить снова</Button></> :
        <p role="status">Проверяем аккаунт…</p>) : account === null ? <>
          <p>Войдите с адресом, на который отправили приглашение. Ссылка продолжится после входа в текущей вкладке.</p>
          <LinkButton variant="primary" href="/?login=1&next=%2Flibrary-invite">Войти и продолжить</LinkButton>
        </> : <>
          <p>Проверьте аккаунт и нажмите кнопку, чтобы принять доступ. Подтверждение почты выполняется отдельно.</p>
          {error && <Notice tone="error">{error}</Notice>}
          <Button variant="primary" busy={busy} onClick={accept}>Принять приглашение</Button>
          <p className="fine">Если это не тот аккаунт, выйдите из него и откройте ссылку снова.</p>
        </>}
    </main>
  </AppShell>;
}
