import React, { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, client } from "../../shared/api/client.ts";
import { Button, Notice, TextField } from "../../shared/ui/controls.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import "./styles.css";

type Item = Awaited<ReturnType<typeof client.serviceAccounts.list>>["items"][number];
const SCOPE_LABEL = {
  read: "читать и искать",
  "source:read": "читать исходники",
  capture: "сохранять новые работы",
  revise: "сохранять новые версии",
} as const;
type ServiceScope = keyof typeof SCOPE_LABEL;
const STATUS = { active: "работает", frozen: "заморожен: ответственный ушёл с полки", disabled: "отключён" } as const;

/**
 * Service accounts of the open department shelf: an agent for cron or CI with a
 * person responsible for it (docs/specs/DATA_MODELS.md §3). Shown only to
 * curators when the installation has them on (SERVICE_ACCOUNTS=on).
 */
export function ServiceAccountsSection({ accountId, admin }: { accountId: string; admin: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ServiceScope[]>(["read", "capture"]);
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  // Read by reload after its request: the list was shown at least once.
  const shown = useRef(false);

  const reload = useCallback(async () => {
    try {
      setItems((await client.serviceAccounts.list()).items);
      setLoaded(true);
      shown.current = true;
    } catch (cause) {
      // Off on this installation (404), or not a curator here: nothing to show.
      // Off here (404), or no right: nothing to show, unless it was shown already.
      if (cause instanceof ApiError && [403, 404].includes(cause.status) && !shown.current) setItems(null);
      else setError("Не удалось загрузить сервисные доступы.");
    }
  }, []);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- reload sets state only after the awaited request
    void reload();
  }, [reload]);

  if (items === null && !error && !loaded) return null;

  const run = async (action: () => Promise<{ token?: string } | { ok: true } | void>, label: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      if (result && "token" in result && result.token) setSecret({ name: label, token: result.token });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выполнить действие.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="agent-card" aria-labelledby="service-accounts-title">
      <h2 id="service-accounts-title">Сервисные доступы</h2>
      <p>
        Агент для расписания или CI без человека за клавиатурой. За него отвечает человек: если он уйдёт с полки, доступ
        заморозится, пока администратор не назначит другого. Нельзя давать права «читать» и «ссылки» вместе.
      </p>
      {(items ?? []).map((item) => (
        <div key={item.id} className="agent-existing service-accounts-row">
          <strong>{item.name}</strong> — {STATUS[item.status]}
          {item.responsibleName && <>; отвечает: {item.responsibleName}</>}
          {item.token && (
            <>
              ; права:{" "}
              {item.token.scopes
                .filter((scope): scope is ServiceScope => scope in SCOPE_LABEL)
                .map((scope) => SCOPE_LABEL[scope])
                .join(", ") || "—"}
              ; токен до {new Date(item.token.expiresAt).toLocaleDateString("ru-RU")}
            </>
          )}
          <div className="service-accounts-actions">
            {item.status === "active" && (item.responsibleAccountId === accountId || admin) && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void run(() => client.serviceAccounts.rotate(item.id), item.name)}
              >
                Новый токен
              </Button>
            )}
            {item.status === "frozen" && admin && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void run(() => client.serviceAccounts.setResponsible(item.id, accountId), item.name)}
              >
                Отвечать самому и разморозить
              </Button>
            )}
            {confirming === item.id ? (
              <>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    setSecret(null);
                    void run(() => client.serviceAccounts.disable(item.id), item.name);
                  }}
                >
                  Точно отключить: токены перестанут работать
                </Button>
                <Button type="button" onClick={() => setConfirming(null)}>
                  Отмена
                </Button>
              </>
            ) : (
              <Button type="button" disabled={busy} onClick={() => setConfirming(item.id)}>
                Отключить
              </Button>
            )}
          </div>
        </div>
      ))}
      {secret && (
        <Notice>
          Токен «{secret.name}» показывается только сейчас: <code>{secret.token}</code>{" "}
          <CopyButton value={secret.token} />
        </Notice>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const made = await client.serviceAccounts.create(name.trim(), scopes);
            setName("");
            return made;
          }, name.trim());
        }}
      >
        <TextField
          label="Название"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <fieldset className="service-accounts-scopes">
          <legend>Права</legend>
          {(Object.keys(SCOPE_LABEL) as ServiceScope[]).map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked ? [...current, scope] : current.filter((value) => value !== scope),
                  )
                }
              />{" "}
              {SCOPE_LABEL[scope]}
            </label>
          ))}
        </fieldset>
        <Button variant="primary" type="submit" disabled={busy || !name.trim() || !scopes.length}>
          Создать сервисный доступ
        </Button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
