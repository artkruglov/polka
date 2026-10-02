import React, { useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  client,
  type AccountDeletionPlan,
} from "../../shared/api/client.ts";
import { Dialog } from "../../shared/ui/index.tsx";
import { Button, Notice, TextField } from "../../shared/ui/controls.tsx";

/** The status capability the receipt page reads (never in a URL). */
export const DELETION_CAPABILITY_KEY = "polka.account-deletion";

const CONFIRM_WORD = "УДАЛИТЬ";

function size(bytes: number) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.ceil(bytes / 1024))} КБ`;
}

/**
 * «Удалить аккаунт»: a plan first (what goes, by when), then an explicit
 * confirmation. Nothing is deleted by opening the dialog; confirming closes the
 * account at once and the receipt page (/account-deleted) shows the progress.
 */
export function DeleteAccount({ purge }: { purge: boolean }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<AccountDeletionPlan | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const csrf = React.useRef("");

  async function start() {
    setOpen(true);
    setPlan(null);
    setTyped("");
    setError("");
    setBusy(true);
    try {
      csrf.current = (await client.accountDeletion.csrf()).csrfToken;
      setPlan(await client.accountDeletion.plan(csrf.current));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось подготовить удаление.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!plan) return;
    setBusy(true);
    setError("");
    // Keep the capability first: a lost answer is recovered from the receipt page.
    try {
      if (plan.statusCapability) localStorage.setItem(DELETION_CAPABILITY_KEY, plan.statusCapability);
    } catch {
      /* private mode: the receipt page then says the request is not found */
    }
    try {
      await client.accountDeletion.confirm(plan, csrf.current);
      location.assign("/account-deleted");
    } catch (e) {
      // Not confirmed: the stored capability must not read as a request under way.
      try {
        localStorage.removeItem(DELETION_CAPABILITY_KEY);
      } catch {
        /* nothing stored */
      }
      setError(e instanceof Error ? e.message : "Не удалось отправить заявку.");
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="danger" onClick={start}>
        Удалить аккаунт…
      </Button>
      {open && (
        <Dialog title="Удалить аккаунт?" onClose={() => setOpen(false)} busy={busy}>
          <div className="dialog-body account-deletion">
            {error && <Notice tone="error">{error}</Notice>}
            {!plan && busy && <p>Считаем, что будет удалено…</p>}
            {plan && (
              <>
                <p className="account-deletion-warn">
                  <AlertTriangle aria-hidden="true" /> Это нельзя отменить.
                </p>
                <ul>
                  <li>
                    Работ: {plan.counts.artifacts}, версий: {plan.counts.revisions},{" "}
                    {size(plan.counts.sourceBytes + plan.counts.derivativeBytes)}.
                  </li>
                  <li>Все ссылки закроются, подключения агентов отключатся, вход перестанет работать сразу.</li>
                  <li>
                    {purge
                      ? `Данные удалятся с серверов в течение ${Math.ceil(plan.provisionalPolicy.purgeMaxHours / 24)} дн.; из резервных копий исчезнут, когда копии истекут (до ${plan.provisionalPolicy.backupRetentionMaxDays} дн.).`
                      : "Данные будет удалять оператор этой установки."}
                  </li>
                  <li>Уже скачанные получателями копии вернуть нельзя. Нужные версии скачайте заранее.</li>
                </ul>
                <TextField
                  label={`Чтобы подтвердить, введите ${CONFIRM_WORD}`}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                />
                <div className="dialog-actions">
                  <Button onClick={() => setOpen(false)} disabled={busy}>
                    Отмена
                  </Button>
                  <Button
                    variant="danger"
                    busy={busy}
                    disabled={typed.trim().toUpperCase() !== CONFIRM_WORD}
                    onClick={confirm}
                  >
                    Удалить навсегда
                  </Button>
                </div>
              </>
            )}
            {!plan && !busy && (
              <div className="dialog-actions">
                <Button onClick={() => setOpen(false)}>Закрыть</Button>
                <Button onClick={start}>Повторить</Button>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
