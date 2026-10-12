import React, { useEffect, useState } from "react";
import { Search, ShieldCheck, UserMinus, Users } from "lucide-react";
import { ApiError, client, request } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { Button, Notice, StatusPanel } from "../../shared/ui/controls.tsx";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { ROLE_LABEL, switchShelf } from "../../entities/shelf/model.ts";
import type { ShelfRole } from "../../shared/api/client.ts";
import { ensureExtensions, useSlot } from "../../shared/extensions/index.ts";
import { useCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import "./styles.css";

// The company admin's page (docs/specs/TEAM_SHELVES.md, stage 4): every
// department shelf, and taking a leaving employee off all of them at once.

type CompanyShelf = {
  id: string;
  name: string;
  createdAt: string;
  members: number;
  works: number;
  admins: string[];
};
type Member = { accountId: string; name: string; email: string | null; role: ShelfRole };
type Employee = {
  accountId: string;
  name: string;
  email: string | null;
  disabled: boolean;
  shelves: { id: string; name: string; role: ShelfRole }[];
  teamAgents: number;
};

const company = {
  /** organisation: on a shared cloud, the one this admin runs. */
  shelves: () => request<{ items: CompanyShelf[]; organisation?: string | null }>("/company/shelves"),
  members: (id: string) => request<{ items: Member[] }>(`/company/shelves/${id}/members`),
  admin: (id: string) => request(`/company/shelves/${id}/admin`, {}),
  find: (who: string) => request<Employee>(`/company/people?${new URLSearchParams({ who })}`),
  offboard: (id: string) =>
    request<{ removed: { id: string; name: string; role: ShelfRole }[] }>(`/company/people/${id}/offboard`, {}),
};

const plural = (n: number, one: string, few: string, many: string) => {
  const rule = new Intl.PluralRules("ru").select(n);
  return `${n} ${rule === "one" ? one : rule === "few" ? few : many}`;
};

function ShelfRow({ shelf, onChanged }: { shelf: CompanyShelf; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || members) return;
    company
      .members(shelf.id)
      .then((page) => setMembers(page.items))
      .catch((e) => setError((e as Error).message));
  }, [open, members, shelf.id]);
  return (
    <li className="company-shelf">
      <div className="company-shelf-head">
        <div>
          <strong>{shelf.name}</strong>
          <small>
            {plural(shelf.members, "участник", "участника", "участников")} ·{" "}
            {plural(shelf.works, "работа", "работы", "работ")} ·{" "}
            {shelf.admins.length ? `администраторы: ${shelf.admins.join(", ")}` : "без администратора"}
          </small>
        </div>
        <div className="company-shelf-actions">
          {!shelf.admins.length && (
            <Button
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await company.admin(shelf.id);
                  onChanged();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ShieldCheck /> Стать администратором
            </Button>
          )}
          <Button variant="quiet" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
            <Users /> {open ? "Скрыть участников" : "Участники"}
          </Button>
        </div>
      </div>
      <ErrorNotice error={error} />
      {open &&
        (members === null ? (
          <p className="company-muted" role="status">
            Загружаем…
          </p>
        ) : (
          <ul className="company-members">
            {members.map((member) => (
              <li key={member.accountId}>
                <span>
                  {member.name}
                  {member.email && <small>{member.email}</small>}
                </span>
                <span className="company-muted">{ROLE_LABEL[member.role]}</span>
              </li>
            ))}
          </ul>
        ))}
    </li>
  );
}

/**
 * What happens to the person's sign-in. Offboarding closes department shelves
 * only: sign-in itself is closed by the company's SSO when an extension
 * provides one; on a shared cloud the person keeps the account and personal
 * shelf; on an own installation its operator disables the account.
 */
export function signInAfterOffboarding(sso: boolean, cloud: boolean) {
  if (sso) return "Вход в Полку закрывается в SSO компании.";
  if (cloud) return "Аккаунт и личная полка остаются у человека: компания закрывает доступ только к своим полкам.";
  return "Чтобы закрыть и вход в Полку, попросите того, кто обслуживает установку, отключить аккаунт.";
}

/**
 * everywhere: «со всех полок отделов», or on a shared cloud «… компании»: the
 * other companies' shelves are not this admin's.
 */
function Offboarding({ everywhere, signIn }: { everywhere: string; signIn: string }) {
  const [who, setWho] = useState("");
  const [person, setPerson] = useState<Employee | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [confirm, setConfirm] = useState(false);
  const find = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!who.trim() || busy) return;
    setBusy(true);
    setError("");
    setDone("");
    setPerson(null);
    try {
      setPerson(await company.find(who.trim()));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? "Такого сотрудника нет в Полке. Проверьте почту или логин."
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  const offboard = async () => {
    if (!person) return;
    setBusy(true);
    setError("");
    try {
      const { removed } = await company.offboard(person.accountId);
      setDone(
        removed.length
          ? `${person.name} больше не на полках ${removed.map((shelf) => `«${shelf.name}»`).join(", ")}. Агенты сотрудника на этих полках отключены, работы остались.`
          : `${person.name} уже не состоит ни в одной полке отдела.`,
      );
      setPerson({ ...person, shelves: [], teamAgents: 0 });
      setConfirm(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="company-card" aria-labelledby="offboard-title">
      <h2 id="offboard-title">Сотрудник уходит</h2>
      <p className="company-muted">
        Уберите сотрудника {everywhere} одним действием: участие и агенты сотрудника на этих полках закроются, работы
        останутся у отделов. {signIn}
      </p>
      <form className="company-find" onSubmit={find}>
        <label className="ui-search">
          <Search aria-hidden="true" />
          <input
            aria-label="Почта или логин сотрудника"
            placeholder="Почта или логин сотрудника"
            value={who}
            onChange={(event) => setWho(event.target.value)}
          />
        </label>
        <Button type="submit" busy={busy && !person}>
          Найти
        </Button>
      </form>
      <ErrorNotice error={error} />
      {done && <Notice>{done}</Notice>}
      {person && (
        <div className="company-person">
          <strong>{person.name}</strong>
          {person.email && <small>{person.email}</small>}
          {person.shelves.length ? (
            <>
              <p>
                Полки отделов:{" "}
                {person.shelves.map((shelf) => `«${shelf.name}» (${ROLE_LABEL[shelf.role].toLowerCase()})`).join(", ")}
                {person.teamAgents
                  ? ` · ${plural(person.teamAgents, "агент", "агента", "агентов")} на этих полках`
                  : ""}
              </p>
              <Button variant="primary" onClick={() => setConfirm(true)} disabled={busy}>
                <UserMinus /> Убрать {everywhere}
              </Button>
            </>
          ) : (
            <p className="company-muted">Не состоит ни в одной полке отдела.</p>
          )}
        </div>
      )}
      {confirm && person && (
        <Dialog title={`Убрать ${person.name} ${everywhere}?`} busy={busy} onClose={() => !busy && setConfirm(false)}>
          <div className="dialog-body">
            <p>
              {person.name} перестанет видеть полки {person.shelves.map((shelf) => `«${shelf.name}»`).join(", ")},
              агенты сотрудника на них отключатся. Работы останутся на полках. Там, где других администраторов не было,
              администратором станете вы.
            </p>
          </div>
          <div className="dialog-footer">
            <Button onClick={() => setConfirm(false)} disabled={busy}>
              Отмена
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void offboard()}>
              Убрать
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

export function CompanyAdmin() {
  const account = useAccount();
  const capabilities = useCapabilities();
  const sso = capabilities.status === "ready" && capabilities.capabilities.extensionSignIn.length > 0;
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "denied"; cloud: boolean; contact: string | null }
    | { kind: "error"; message: string }
    | { kind: "ready"; shelves: CompanyShelf[]; organisation: string | null }
  >({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  // Sections of extensions, e.g. the commercial edition's link policy.
  const extensionSections = useSlot("company-admin");
  useEffect(() => {
    if (state.kind !== "ready") return;
    void ensureExtensions();
  }, [state.kind]);
  useEffect(() => {
    if (account === undefined) return;
    if (account === null) {
      location.assign(`/signin?next=${encodeURIComponent("/settings/company")}`);
      return;
    }
    // Only a company admin (canCreate) asks for the company's shelves: anyone
    // else would get a 404. On a shared cloud the page says whom a company
    // writes to.
    const denied = (shelves: Awaited<ReturnType<typeof client.shelves>> | null) =>
      setState({ kind: "denied", cloud: shelves?.scope === "organisation", contact: shelves?.contact ?? null });
    client
      .shelves()
      .catch(() => null)
      .then(async (shelves) => {
        if (!shelves?.canCreate) return denied(shelves);
        try {
          const page = await company.shelves();
          setState({ kind: "ready", shelves: page.items, organisation: page.organisation ?? null });
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) denied(shelves);
          else setState({ kind: "error", message: (e as Error).message });
        }
      });
  }, [account, refresh]);
  return (
    <AppShell current="shelf" account={account}>
      <main className="company-page">
        <header>
          {state.kind === "ready" && <span className="eyebrow">Администратор компании</span>}
          <h1>Полки компании</h1>
        </header>
        {state.kind === "loading" && (
          <p className="company-muted" role="status">
            Загружаем…
          </p>
        )}
        {state.kind === "denied" &&
          (state.cloud ? (
            <StatusPanel title="Полки отделов для вашей компании">
              Полки отделов создаёт и ведёт администратор компании: заводит полки, добавляет сотрудников и приглашает
              коллег ссылкой. Чтобы ваша компания получила полки,{" "}
              {state.contact ? (
                <>
                  напишите на <a href={`mailto:${state.contact}`}>{state.contact}</a>
                </>
              ) : (
                "напишите оператору Полки"
              )}{" "}
              — назначим администратора компании. Администратору видны только полки и сотрудники своей компании.
            </StatusPanel>
          ) : (
            <StatusPanel title="Эта страница — для администратора компании">
              Полки отделов создаёт и ведёт администратор компании. Назначает администратора тот, кто обслуживает
              установку Полки.
            </StatusPanel>
          ))}
        {state.kind === "error" && <StatusPanel title="Не удалось загрузить">{state.message}</StatusPanel>}
        {state.kind === "ready" && (
          <>
            <Offboarding
              everywhere={state.organisation ? "со всех полок отделов компании" : "со всех полок отделов"}
              signIn={signInAfterOffboarding(sso, Boolean(state.organisation))}
            />
            {extensionSections.map(({ id, title, Component }) => (
              <section key={id} className="company-card" aria-label={title}>
                <h2>{title}</h2>
                <Component />
              </section>
            ))}
            <section className="company-card" aria-labelledby="shelves-title">
              <h2 id="shelves-title">Полки отделов · {state.shelves.length}</h2>
              {state.shelves.length ? (
                <ul className="company-shelves">
                  {state.shelves.map((shelf) => (
                    <ShelfRow key={shelf.id} shelf={shelf} onChanged={() => setRefresh((n) => n + 1)} />
                  ))}
                </ul>
              ) : (
                <p className="company-muted">
                  Полок отделов пока нет.{" "}
                  <button type="button" className="text-button" onClick={() => switchShelf(null)}>
                    Создайте первую
                  </button>{" "}
                  в переключателе полок на своей полке.
                </p>
              )}
            </section>
          </>
        )}
      </main>
    </AppShell>
  );
}
