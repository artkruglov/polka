import { Button, SelectField } from "../../shared/ui/controls.tsx";
import React, { useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Link as LinkIcon,
  LockKeyhole,
} from "lucide-react";
import type { Artifact } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import { date } from "../../entities/artifact/format.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
export function SharePanel({
  artifact: a,
  onClose,
  onChange,
}: {
  artifact: Artifact;
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [days, setDays] = useState(7),
    [copied, setCopied] = useState(false);
  const active = a.share && ["active", "behind"].includes(a.share.status);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setConfirm(false);
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Поделиться ссылкой" onClose={onClose} busy={busy}>
      <div className="dialog-body">
        <div className="share-summary">
          <div className="soft-icon">
            {active ? <LinkIcon /> : <LockKeyhole />}
          </div>
          <div>
            <strong>{active ? "Доступ по ссылке" : "Только вы"}</strong>
            <p>
              {active
                ? `Получатель видит версию ${a.share!.number}`
                : "Работа закрыта для других людей"}
            </p>
          </div>
        </div>
        {active ? (
          <>
            <p>
              Любой человек с этой ссылкой откроет работу в браузере: вход в
              Полку и аккаунт в Claude или ChatGPT не нужны. Ссылку можно
              переслать.
            </p>
            <div className="link-address">{a.share!.url}</div>
            <p className="fine">
              Действует до {date(a.share!.expiresAt)}. Не добавляется в
              публичный каталог; поисковикам передаётся запрет индексации.
            </p>
            {a.share!.status === "behind" && (
              <div className="update-note">
                <strong>На полке уже версия {a.revision.number}</strong>
                <p>
                  По отправленной ссылке пока открывается версия{" "}
                  {a.share!.number}.
                </p>
                <Button
                  onClick={() => run(() => client.publish(a))}
                  disabled={busy}
                >
                  Обновить ссылку до v{a.revision.number}
                  <ArrowUpRight />
                </Button>
              </div>
            )}
            {confirm ? (
              <div className="revoke-confirm">
                <strong>Закрыть доступ по этой ссылке?</strong>
                <p>
                  Следующее открытие будет недоступно. Уже полученную копию
                  отозвать нельзя.
                </p>
                <div className="button-row">
                  <Button onClick={() => setConfirm(false)} disabled={busy}>
                    Оставить доступ
                  </Button>
                  <Button
                    className="danger"
                    onClick={() => run(() => client.revoke(a.share!.id))}
                    disabled={busy}
                  >
                    Закрыть доступ
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                className="text-button danger"
                onClick={() => setConfirm(true)}
              >
                Закрыть доступ по ссылке
              </Button>
            )}
          </>
        ) : (
          <>
            <p>
              {a.share?.status === "revoked"
                ? "Старая ссылка закрыта навсегда. При повторном включении создадим новый адрес."
                : a.share?.status === "expired"
                  ? "Срок ссылки истёк. Можно создать новый адрес."
                  : "Включите доступ, чтобы отправить эту работу другу или коллеге. Вход в Полку и аккаунт в исходном сервисе получателю не понадобятся."}
            </p>
            <SelectField
              label="Срок доступа"
              value={days}
              onChange={(e) => setDays(+e.target.value)}
            >
              <option value={1}>1 день</option>
              <option value={7}>7 дней</option>
              <option value={30}>30 дней</option>
            </SelectField>
            <p className="fine">
              Доступ получит любой, кому передали ссылку. Индексация отключена,
              но это не закрытое приглашение.
            </p>
          </>
        )}
        <ErrorNotice error={error} />
      </div>
      <div className="dialog-footer">
        <Button onClick={onClose} disabled={busy}>
          Готово
        </Button>
        {active ? (
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(a.share!.url!);
                setCopied(true);
              } catch {
                setError("Не удалось скопировать. Выделите адрес выше.");
              }
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "Скопировано" : "Скопировать ссылку"}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => run(() => client.enable(a, days))}
          >
            {a.share ? "Создать новую ссылку" : "Включить доступ по ссылке"}
            <LinkIcon />
          </Button>
        )}
      </div>
    </Dialog>
  );
}
