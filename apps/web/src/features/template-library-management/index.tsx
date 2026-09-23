import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, SelectField, TextAreaField, TextField } from "../../shared/ui/controls.tsx";
import { CopyText } from "../../shared/ui/CopyText.tsx";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { request, ApiError } from "../../shared/api/client.ts";
import type { Account } from "../../../../../packages/contracts/index.ts";
import "./styles.css";

export type ManagedLibrary = { id: string; name: string; role: "reader" | "curator" | "admin" };
type Member = { accountId: string; name: string; role: ManagedLibrary["role"]; joinedAt: string };
type Invitation = { id: string; email: string; role: ManagedLibrary["role"]; status: string; expiresAt: string; acceptedAt?: string | null };
type Publication = { id: string; releaseId: string; title: string; summary: string; revisionId: string; publishedAt: string };
type Release = { releaseId: string; title: string; summary: string; revisionNumber: number; isLatest: boolean };
type LibraryEvent = {
  id: string;
  libraryId: string;
  actor: { id: string | null; deleted: boolean };
  action: string;
  target: { type: string; id: string | null; deleted: boolean };
  oldRole: ManagedLibrary["role"] | null;
  newRole: ManagedLibrary["role"] | null;
  createdAt: string;
};

const roleLabel = { reader: "читатель", curator: "куратор", admin: "администратор" };
const invitationLabel: Record<string, string> = { pending: "ожидает принятия", accepted: "принято", revoked: "отозвано", expired: "срок истёк", redacted: "данные удалены" };
const eventActionLabel: Record<string, string> = {
  "template_library.created": "создал библиотеку",
  "template_library.invitation_created": "создал приглашение",
  "template_library.invitation_accepted": "принял приглашение",
  "template_library.domain_joined": "вошёл через домен компании",
  "template_library.invitation_revoked": "отозвал приглашение",
  "template_library.member_revoked": "отозвал участника",
  "template_library.member_role_changed": "изменил роль участника",
  "template_library.release_published": "опубликовал выпуск",
  "template_library.publication_withdrawn": "убрал выпуск из библиотеки",
};

function message(error: unknown) {
  if (error instanceof ApiError && error.status === 409 && /администратор/i.test(error.message))
    return "Сначала назначьте другого активного администратора.";
  return error instanceof Error ? error.message : "Не удалось выполнить действие.";
}

function shortId(id: string | null | undefined) {
  return id ? id.slice(0, 8) : "неизвестный ID";
}

function eventPerson(person: { id: string | null; deleted: boolean }, members: Member[]) {
  if (person.deleted || !person.id) return "Удалённый аккаунт";
  return members.find((member) => member.accountId === person.id)?.name || `ID ${shortId(person.id)}`;
}

function eventTarget(event: LibraryEvent, members: Member[]) {
  if (event.target.type === "account") return eventPerson(event.target, members);
  const targetLabel: Record<string, string> = { library: "библиотеку", invitation: "приглашение", publication: "выпуск" };
  return `${targetLabel[event.target.type] ?? event.target.type} · ID ${shortId(event.target.id)}`;
}

function roleText(role: ManagedLibrary["role"] | null) {
  return role ? roleLabel[role] : "не назначена";
}

function HistoryDialog({ library, accountId, members, onClose }: { library: ManagedLibrary; accountId: string; members: Member[]; onClose: () => void }) {
  const [items, setItems] = useState<LibraryEvent[]>([]), [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const requestEpoch = useRef(0);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => {
    const epoch = ++requestEpoch.current;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoadingMore(false);
    setItems([]);
    setNextBefore(null);
    setError("");
    if (library.role !== "admin") {
      setLoading(false);
      setError("История доступна только администраторам.");
      return () => controller.abort();
    }
    setLoading(true);
    request<{ items: LibraryEvent[]; nextBefore: string | null }>(
      `/template-libraries/${library.id}/events?limit=50`, undefined, "GET", controller.signal,
    ).then((result) => {
      if (controller.signal.aborted || epoch !== requestEpoch.current) return;
      setItems(result.items);
      setNextBefore(result.nextBefore);
    }).catch((reason) => {
      if (controller.signal.aborted || epoch !== requestEpoch.current) return;
      setItems([]);
      setNextBefore(null);
      setError(reason instanceof ApiError && (reason.status === 403 || reason.status === 404)
        ? "История недоступна для этого аккаунта или библиотеки."
        : message(reason));
    }).finally(() => epoch === requestEpoch.current && setLoading(false));
    return () => {
      controller.abort();
      loadMoreController.current?.abort();
      loadMoreController.current = null;
    };
  }, [accountId, library.id, library.role, retry]);

  async function loadMore() {
    if (!nextBefore || loadingMore || library.role !== "admin") return;
    const epoch = requestEpoch.current;
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMore(true);
    try {
      const result = await request<{ items: LibraryEvent[]; nextBefore: string | null }>(
        `/template-libraries/${library.id}/events?${new URLSearchParams({ before: nextBefore, limit: "50" })}`,
        undefined, "GET", controller.signal,
      );
      if (controller.signal.aborted || epoch !== requestEpoch.current) return;
      setItems((current) => [...current, ...result.items]);
      setNextBefore(result.nextBefore);
    } catch (reason) {
      if (epoch !== requestEpoch.current || controller.signal.aborted) return;
      if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) {
        setItems([]);
        setNextBefore(null);
      }
      setError(reason instanceof ApiError && (reason.status === 403 || reason.status === 404)
        ? "История недоступна для этого аккаунта или библиотеки."
        : message(reason));
    } finally {
      if (loadMoreController.current === controller) loadMoreController.current = null;
      if (epoch === requestEpoch.current) setLoadingMore(false);
    }
  }

  return <Dialog title="История библиотеки" onClose={onClose}>
    <div className="library-history-body">
      {loading && <p role="status">Загружаем историю…</p>}
      {!loading && error && <><ErrorNotice error={error} /><Button onClick={() => setRetry((value) => value + 1)}>Повторить</Button></>}
      {!loading && !error && items.length === 0 && <p className="fine">Событий пока нет.</p>}
      {!loading && !error && items.length > 0 && <div className="library-history-list">
        {items.map((event) => <article className="library-history-row" key={event.id}>
          <div><strong>{eventPerson(event.actor, members)} {eventActionLabel[event.action] ?? event.action}</strong><p>{eventTarget(event, members)}{event.oldRole || event.newRole ? ` · ${roleText(event.oldRole)} → ${roleText(event.newRole)}` : ""}</p></div>
          <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}</time>
        </article>)}
      </div>}
      {!loading && !error && nextBefore && <Button onClick={loadMore} busy={loadingMore}>Показать ещё</Button>}
    </div>
  </Dialog>;
}

export function CreateLibrary({ accountId, onCreated }: { accountId: string; onCreated: (library: ManagedLibrary) => void }) {
  const [open, setOpen] = useState(false), [name, setName] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  if (!accountId) return null;
  return <>
    <Button onClick={() => { setOpen(true); setError(""); }}>Создать библиотеку</Button>
    {open && <Dialog title="Создать библиотеку" onClose={() => !busy && setOpen(false)} busy={busy}>
      <form className="library-form" onSubmit={async (event) => { event.preventDefault(); if (busy) return; setBusy(true); setError(""); try { const result = await request<ManagedLibrary>("/template-libraries", { name }); onCreated(result); setOpen(false); setName(""); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>
        <TextField label="Название" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus placeholder="Например, Команда дизайна" />
        <ErrorNotice error={error} />
        <div className="dialog-actions"><Button type="submit" variant="primary" busy={busy}>Создать</Button><Button onClick={() => setOpen(false)} disabled={busy}>Отмена</Button></div>
      </form>
    </Dialog>}
  </>;
}

export function TemplateLibraryManagement({ library, account, personalReleases, onRefreshCatalog, onRefreshLibraries }: { library: ManagedLibrary; account: Account; personalReleases: Release[]; onRefreshCatalog: () => void; onRefreshLibraries: () => void }) {
  const [members, setMembers] = useState<Member[]>([]), [invitations, setInvitations] = useState<Invitation[]>([]), [publications, setPublications] = useState<Publication[]>([]);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(""), [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<"members" | "invite" | "history" | "publish" | "withdraw" | null>(null), [selectedPublication, setSelectedPublication] = useState<Publication | null>(null);
  const [actionKey, setActionKey] = useState(""), [actionError, setActionError] = useState(""), [inviteLink, setInviteLink] = useState("");
  const epoch = useRef(0), canAdmin = library.role === "admin", canPublish = canAdmin || library.role === "curator";
  const selected = useMemo(() => personalReleases[0], [personalReleases]);
  useEffect(() => {
    const id = ++epoch.current; setLoading(true); setLoadError(""); setMembers([]); setInvitations([]); setPublications([]);
    const membersPromise = request<{ items: Member[] }>(`/template-libraries/${library.id}/members`);
    const publicationsPromise = request<{ items: Publication[] }>(`/template-libraries/${library.id}/publications`);
    const invitationsPromise = canAdmin ? request<{ items: Invitation[] }>(`/template-libraries/${library.id}/invitations`) : Promise.resolve({ items: [] as Invitation[] });
    Promise.all([membersPromise, publicationsPromise, invitationsPromise]).then(([memberResult, publicationResult, invitationResult]) => { if (id !== epoch.current) return; setMembers(memberResult.items); setPublications(publicationResult.items); setInvitations(invitationResult.items); }).catch((e) => id === epoch.current && setLoadError(message(e))).finally(() => id === epoch.current && setLoading(false));
    return () => { epoch.current++; };
  }, [library.id, library.role, reload, canAdmin]);
  async function mutate(key: string, fn: () => Promise<void>, onSuccess?: () => void) { if (actionKey) return; const operationEpoch = epoch.current; setActionKey(key); setActionError(""); try { await fn(); if (operationEpoch === epoch.current) { if (key.startsWith("invite-")) setInviteLink(""); setReload((v) => v + 1); onSuccess?.(); } } catch (e) { if (operationEpoch === epoch.current) setActionError(message(e)); } finally { if (operationEpoch === epoch.current) setActionKey(""); } }
  return <section className="library-management" aria-label="Управление библиотекой">
    <div className="library-management-head"><div><h2>Управление библиотекой</h2><p className="fine">Ваша роль: {library.role === "admin" ? "администратор" : library.role === "curator" ? "куратор" : "читатель"}.</p></div><div className="library-management-actions"><Button onClick={() => setDialog("members")}>Участники</Button>{canAdmin && <Button onClick={() => setDialog("history")}>История</Button>}{canPublish && <Button variant="primary" onClick={() => { setActionError(""); setDialog("publish"); }}>Добавить шаблон</Button>}</div></div>
    <p className="library-ownership-note">Исходник принадлежит автору. Если владелец удалит или заблокирует аккаунт, чтение выпуска в библиотеке закроется. Библиотека не является независимым корпоративным хранилищем; уже скачанные копии остаются у получателей.</p>
    {loadError && <><ErrorNotice error={loadError} /><Button onClick={() => setReload((v) => v + 1)}>Повторить</Button></>}
    {loading ? <p role="status">Загружаем управление…</p> : <div className="library-publications"><h3>Опубликованные шаблоны</h3>{publications.length === 0 ? <p className="fine">Пока нет опубликованных выпусков.</p> : publications.map((publication) => <article className="library-publication" key={publication.id}><div><strong>{publication.title}</strong><p>{publication.summary}</p><small>Опубликован {new Date(publication.publishedAt).toLocaleDateString("ru-RU")}</small></div>{canPublish && <Button onClick={() => { setSelectedPublication(publication); setActionError(""); setDialog("withdraw"); }}>Убрать из библиотеки</Button>}</article>)}</div>}
    {dialog === "members" && <MembersDialog library={library} members={members} invitations={invitations} canAdmin={canAdmin} onClose={() => setDialog(null)} onInvite={() => { setActionError(""); setInviteLink(""); setDialog("invite"); }} onMutation={(key, fn) => mutate(key, fn, onRefreshLibraries)} actionKey={actionKey} actionError={actionError} />}
    {dialog === "history" && <HistoryDialog library={library} accountId={account.id} members={members} onClose={() => setDialog(null)} />}
    {dialog === "invite" && <InviteDialog library={library} onClose={() => setDialog(null)} onCreated={(url) => { setInviteLink(url); setDialog(null); setReload((v) => v + 1); }} />}
    {dialog === "publish" && <PublishDialog releases={personalReleases} selected={selected} onClose={() => setDialog(null)} onSubmit={(releaseId) => mutate("publish", async () => { await request(`/template-libraries/${library.id}/publications`, { releaseId }); setDialog(null); }, onRefreshCatalog)} busy={actionKey === "publish"} error={actionError} />}
    {dialog === "withdraw" && selectedPublication && <WithdrawDialog publication={selectedPublication} onClose={() => setDialog(null)} onSubmit={(reason) => mutate("withdraw", async () => { await request(`/template-libraries/${library.id}/publications/${selectedPublication.id}/withdraw`, { reason }); setDialog(null); }, onRefreshCatalog)} busy={actionKey === "withdraw"} error={actionError} />}
    {inviteLink && <div className="invite-result"><strong>Ссылка приглашения готова</strong><p>Письмо автоматически не отправлено. Передайте ссылку приглашённому сотруднику.</p><CopyText value={inviteLink} label="Ссылка приглашения" rows={2} /><Button onClick={() => setInviteLink("")}>Закрыть</Button></div>}
  </section>;
}

function MembersDialog({ library, members, invitations, canAdmin, onClose, onInvite, onMutation, actionKey, actionError }: { library: ManagedLibrary; members: Member[]; invitations: Invitation[]; canAdmin: boolean; onClose: () => void; onInvite: () => void; onMutation: (key: string, fn: () => Promise<void>) => void; actionKey: string; actionError: string }) {
  return <Dialog title="Участники" onClose={onClose} busy={!!actionKey}><div className="library-members-body"><div className="member-list"><p className="fine">Участники видят опубликованные версии и их роли.</p>{members.map((member) => <div className="member-row" key={member.accountId}><span><strong>{member.name}</strong><small>{roleLabel[member.role]}</small></span>{canAdmin && <span className="member-actions"><SelectField label={`Роль ${member.name}`} aria-label={`Роль ${member.name}`} value={member.role} onChange={(e) => onMutation(`role-${member.accountId}`, () => request(`/template-libraries/${library.id}/members/${member.accountId}`, { role: e.target.value }, "PATCH").then(() => undefined))}><option value="reader">читатель</option><option value="curator">куратор</option><option value="admin">администратор</option></SelectField><Button onClick={() => onMutation(`revoke-${member.accountId}`, () => request(`/template-libraries/${library.id}/members/${member.accountId}/revoke`, {}).then(() => undefined))} busy={actionKey === `revoke-${member.accountId}`}>Отозвать</Button></span>}</div>)}</div>{canAdmin && <><Button variant="primary" onClick={onInvite}>Пригласить</Button><h3>Приглашения</h3>{invitations.map((inv) => <div className="invitation-row" key={inv.id}><span>{inv.email} · {roleLabel[inv.role]} · {invitationLabel[inv.status] ?? "недоступно"}</span>{inv.status === "pending" && <Button onClick={() => onMutation(`invite-${inv.id}`, () => request(`/template-libraries/${library.id}/invitations/${inv.id}/revoke`, {}).then(() => undefined))} busy={actionKey === `invite-${inv.id}`}>Отозвать</Button>}</div>)}</>}{actionError && <ErrorNotice error={actionError} />}</div></Dialog>;
}

function InviteDialog({ library, onClose, onCreated }: { library: ManagedLibrary; onClose: () => void; onCreated: (url: string) => void }) { const [email, setEmail] = useState(""), [role, setRole] = useState("reader"), [hours, setHours] = useState("72"), [error, setError] = useState(""), [busy, setBusy] = useState(false); return <Dialog title="Пригласить участника" onClose={() => !busy && onClose()} busy={busy}><form className="library-form" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(""); try { const result = await request<{ invitationUrl: string }>(`/template-libraries/${library.id}/invitations`, { email, role, expiresInHours: Number(hours) }); onCreated(result.invitationUrl); } catch (x) { setError(message(x)); } finally { setBusy(false); } }}><TextField label="Почта" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /><SelectField label="Роль" value={role} onChange={(e) => setRole(e.target.value)}><option value="reader">читатель</option><option value="curator">куратор</option><option value="admin">администратор</option></SelectField><SelectField label="Срок действия" value={hours} onChange={(e) => setHours(e.target.value)}><option value="24">24 часа</option><option value="72">72 часа</option><option value="168">7 дней</option></SelectField><ErrorNotice error={error} /><Button type="submit" variant="primary" busy={busy}>Создать приглашение</Button></form></Dialog>; }
function PublishDialog({ releases, selected, onClose, onSubmit, busy, error }: { releases: Release[]; selected?: Release; onClose: () => void; onSubmit: (id: string) => void; busy: boolean; error: string }) { const [id, setId] = useState(selected?.releaseId ?? ""); const current = releases.find((r) => r.releaseId === id); return <Dialog title="Добавить шаблон" onClose={() => !busy && onClose()} busy={busy}><div className="library-form"><SelectField label="Ваш закреплённый выпуск" value={id} onChange={(e) => setId(e.target.value)}><option value="">Выберите выпуск</option>{releases.map((r) => <option key={r.releaseId} value={r.releaseId}>{r.title} · v{r.revisionNumber}{r.isLatest ? " · последний" : ""}</option>)}</SelectField>{current && <div className="release-confirm"><strong>{current.title} · версия {current.revisionNumber}</strong><p>{current.summary}</p><p className="fine">Публикуются исходники и правила этого личного выпуска.</p></div>}<ErrorNotice error={error} /><div className="dialog-actions"><Button variant="primary" disabled={!current} onClick={() => current && onSubmit(current.releaseId)} busy={busy}>Опубликовать</Button><Button onClick={onClose} disabled={busy}>Отмена</Button></div></div></Dialog>; }
function WithdrawDialog({ publication, onClose, onSubmit, busy, error }: { publication: Publication; onClose: () => void; onSubmit: (reason: string) => void; busy: boolean; error: string }) { const [reason, setReason] = useState(""); return <Dialog title="Убрать шаблон из библиотеки" onClose={() => !busy && onClose()} busy={busy}><form className="library-form" onSubmit={(e) => { e.preventDefault(); onSubmit(reason); }}><p><strong>{publication.title}</strong></p><TextAreaField label="Причина" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} /><p className="fine">Личный оригинал автора останется у него. Уже скачанные копии удалить нельзя.</p><ErrorNotice error={error} /><Button type="submit" variant="primary" busy={busy}>Убрать из библиотеки</Button></form></Dialog>; }
