import React, { useEffect, useState } from "react";
import { ApiError, client, type AccountDeletionReceipt } from "../../shared/api/client.ts";
import { DELETION_CAPABILITY_KEY } from "../../features/account-deletion/index.tsx";
import { LinkButton } from "../../shared/ui/controls.tsx";
import "./styles.css";

function day(iso: string | null) {
  return iso
    ? new Date(iso)
        .toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
        .replace(/\s*г\.$/, " г")
    : "";
}

/**
 * What happened to a deletion request. Public on purpose (the session is gone
 * once it is confirmed): the status capability sits in this browser, never in
 * the address, and the answer carries no content.
 */
export function AccountDeleted() {
  const [capability] = useState(() => {
    try {
      return localStorage.getItem(DELETION_CAPABILITY_KEY);
    } catch {
      return null;
    }
  });
  const [receipt, setReceipt] = useState<AccountDeletionReceipt | null>(null);
  const [failed, setFailed] = useState(!capability);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    if (!capability) return;
    let stop = false;
    const load = () =>
      client.accountDeletion.status(capability).then(
        (next) => {
          if (stop) return;
          setReceipt(next);
          setFailed(false);
          setUnreachable(false);
        },
        (error) => {
          if (stop) return;
          // Only «not found» says there is no request; a hiccup keeps the last answer.
          if (error instanceof ApiError && error.status === 404) setFailed(true);
          else setUnreachable(true);
        },
      );
    load();
    const timer = setInterval(() => {
      if (receipt?.state !== "purged") load();
    }, 30_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [capability, receipt?.state]);
  return (
    <main className="deleted-page">
      <span className="eyebrow">Удаление аккаунта</span>
      {failed && !receipt ? (
        <>
          <h1>Заявка не найдена в этом браузере</h1>
          <p>
            Если вы удаляли аккаунт с другого устройства, статус виден только там. Заявка могла не отправиться: тогда
            аккаунт остался на месте, и вы можете войти.
          </p>
          <LinkButton href="/signup">Войти</LinkButton>
        </>
      ) : !receipt ? (
        <>
          <h1>{unreachable ? "Статус сейчас недоступен" : "Читаем статус…"}</h1>
          {unreachable && <p>Не удалось связаться с Полкой. Страница попробует ещё раз.</p>}
        </>
      ) : receipt.state === "planned" ? (
        <>
          <h1>Заявка не подтверждена</h1>
          <p>Удаление не началось, аккаунт на месте. Войдите и повторите, если всё ещё хотите удалить его.</p>
          <LinkButton href="/signup">Войти</LinkButton>
        </>
      ) : receipt.state === "purged" ? (
        <>
          <h1>Данные удалены</h1>
          <p>
            Работы, версии, ссылки и подключения стёрты. Из резервных копий данные исчезнут до{" "}
            {day(receipt.backupRetentionPolicyDeadline)}.
          </p>
        </>
      ) : receipt.state === "failed" ? (
        <>
          <h1>Удаление остановилось</h1>
          <p>
            Доступ к аккаунту уже закрыт. Оператор видит сбой и продолжит; напишите ему, если ждёте дольше обычного.
          </p>
        </>
      ) : (
        <>
          <h1>Доступ закрыт, данные удаляются</h1>
          <p>
            Вход, ссылки и подключения агентов уже не работают.{" "}
            {receipt.purgeAvailable
              ? `Данные с серверов удалятся не позже ${day(receipt.workingDataPolicyDeadline)}, из резервных копий исчезнут до ${day(receipt.backupRetentionPolicyDeadline)}.`
              : `Данные удалит оператор этой установки не позже ${day(receipt.workingDataPolicyDeadline)}.`}{" "}
            {/* oxlint-disable-next-line react/purity -- the page re-renders on every poll, so the clock is fresh enough */}
            {receipt.workingDataPolicyDeadline && new Date(receipt.workingDataPolicyDeadline).getTime() < Date.now()
              ? "Срок уже прошёл: напишите оператору, он увидит сбой в журнале. "
              : ""}
            Страница обновится сама, пока вы её не закроете.
          </p>
        </>
      )}
      <LinkButton href="/landing" variant="quiet">
        На главную
      </LinkButton>
    </main>
  );
}
