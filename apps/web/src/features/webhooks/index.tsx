import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  WEBHOOK_EVENTS,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
} from "../../../../../packages/contracts/webhooks.ts";
import { ApiError, client } from "../../shared/api/client.ts";
import { Badge, Button, Notice, TextField } from "../../shared/ui/controls.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";

const EVENT_LABEL: Record<WebhookEvent, string> = {
  "revision.saved": "Сохранена работа или новая версия",
  "revision.accepted": "Отмечена принятая версия",
  "owner.changed": "Сменился ответственный",
  "artifact.metadata_updated": "Изменены название или описание",
  "artifact.moved": "Работа перенесена в другую папку",
  "artifact.trashed": "Работа в корзине",
  "artifact.restored": "Работа восстановлена из корзины",
  "share.enabled": "Открыта ссылка",
  "share.revoked": "Ссылка закрыта",
  "comment.created": "Новый комментарий или заметка",
};
const DEFAULT_EVENTS: WebhookEvent[] = ["revision.saved", "revision.accepted"];
const ERROR_LABEL: Record<string, string> = {
  timeout: "не ответил за 10 секунд",
  connection: "не удалось подключиться",
  dns: "имя не находится в DNS",
  blocked_address: "адрес во внутренней сети",
  invalid_url: "неверный адрес",
  redirect: "перенаправление (не выполняется)",
  http: "ответ с ошибкой",
  endpoint_disabled: "отменено: вебхук выключен",
  event_removed: "отменено: событие убрано из списка",
  expired: "отменено: ждало больше недели",
  secret: "секрет не читается — нажмите «Новый секрет»",
};
const DISABLED_LABEL = {
  owner: "выключен",
  failures: "выключен: адрес не отвечал",
  creator: "выключен: добавивший его больше не администратор полки",
} as const;
const STATE_LABEL = { pending: "ждёт повтора", delivered: "доставлено", failed: "не доставлено" } as const;

const time = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function deliveryLine(delivery: WebhookDelivery) {
  const parts = [
    time(delivery.lastAttemptAt ?? delivery.createdAt),
    delivery.action === "ping" ? "проверка" : delivery.action,
    STATE_LABEL[delivery.state],
  ];
  if (delivery.lastStatus) parts.push(`HTTP ${delivery.lastStatus}`);
  if (delivery.lastError && delivery.lastError !== "http")
    parts.push(ERROR_LABEL[delivery.lastError] ?? delivery.lastError);
  if (delivery.attempts > 1) parts.push(`попыток: ${delivery.attempts}`);
  if (delivery.nextAttemptAt && delivery.state === "pending") parts.push(`следующая ${time(delivery.nextAttemptAt)}`);
  return parts.join(" · ");
}

function EventChoice({ value, onChange }: { value: WebhookEvent[]; onChange: (next: WebhookEvent[]) => void }) {
  return (
    <fieldset className="webhooks-events">
      <legend>События</legend>
      {WEBHOOK_EVENTS.map((event) => (
        <label key={event}>
          <input
            type="checkbox"
            checked={value.includes(event)}
            onChange={(change) =>
              onChange(change.target.checked ? [...value, event] : value.filter((item) => item !== event))
            }
          />{" "}
          {EVENT_LABEL[event]} <code>{event}</code>
        </label>
      ))}
    </fieldset>
  );
}

function DeliveryLog({ id }: { id: string }) {
  const [items, setItems] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    client.webhooks
      .deliveries(id)
      .then(({ items }) => live && setItems(items))
      .catch(() => live && setError("Не удалось загрузить журнал."));
    return () => {
      live = false;
    };
  }, [id]);
  if (error) return <p className="ui-field-error">{error}</p>;
  if (!items) return <p role="status">Загружаем журнал…</p>;
  if (!items.length) return <p className="ui-field-hint">Доставок ещё не было.</p>;
  return (
    <ul className="webhooks-log">
      {items.map((delivery) => (
        <li key={delivery.id} data-state={delivery.state}>
          {deliveryLine(delivery)}
          {delivery.responseSnippet && <span className="webhooks-snippet">{delivery.responseSnippet}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * «Вебхуки» of the open shelf (docs/specs/WEBHOOKS.md): addresses that receive
 * the shelf's events, signed. Its owner, or an admin of a department shelf;
 * hidden when the installation has them off (WEBHOOKS=off answers 404).
 */
export function WebhooksSection() {
  const [items, setItems] = useState<Webhook[] | null>(null);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(DEFAULT_EVENTS);
  const [secret, setSecret] = useState<{ url: string; value: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editEvents, setEditEvents] = useState<WebhookEvent[]>([]);
  const [log, setLog] = useState<string | null>(null);
  const [logVersion, setLogVersion] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const shown = useRef(false);

  const reload = useCallback(async () => {
    try {
      setItems((await client.webhooks.list()).items);
      shown.current = true;
    } catch (cause) {
      // Off here (404) or not this shelf's owner or admin (403): nothing to show.
      if (cause instanceof ApiError && [403, 404].includes(cause.status) && !shown.current) setItems(null);
      else setError("Не удалось загрузить вебхуки.");
    }
  }, []);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- reload sets state only after the awaited request
    void reload();
  }, [reload]);

  if (items === null && !error) return null;

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await action();
      if (message) setNotice(message);
      await reload();
      setLogVersion((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выполнить действие.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="agent-card" id="webhooks" aria-labelledby="webhooks-title">
      <h2 id="webhooks-title">Вебхуки</h2>
      <p>
        Полка отправит POST на ваш HTTPS-адрес, когда на полке что-то произойдёт: та же запись, что в ленте событий для
        агентов, — только идентификаторы и время, без содержимого работ. Запрос подписан: заголовок{" "}
        <code>Polka-Signature: t=…,v1=…</code> — HMAC-SHA256 от <code>t.тело</code> секретом вебхука. Если адрес не
        ответил 2xx, Полка повторит позже; после трёх дней одних ошибок вебхук выключится.
      </p>
      {(items ?? []).map((item) => (
        <article key={item.id} className="webhooks-item" data-status={item.status}>
          <div className="webhooks-head">
            <strong className="webhooks-url">{item.url}</strong>
            {item.status === "disabled" && <Badge>{DISABLED_LABEL[item.disabledReason ?? "owner"]}</Badge>}
          </div>
          {item.description && <p className="webhooks-meta">{item.description}</p>}
          <p className="webhooks-meta">
            {item.events.map((event) => EVENT_LABEL[event]).join(", ")}. Секрет начинается с{" "}
            <code>{item.secretHint}</code>.{item.lastSuccessAt && <> Последняя доставка: {time(item.lastSuccessAt)}.</>}
            {item.consecutiveFailures > 0 && <> Ошибок подряд: {item.consecutiveFailures}.</>}
            {item.pausedUntil && <> Отправка приостановлена до {time(item.pausedUntil)}.</>}
            {item.skippedEvents > 0 && <> Пропущено событий (очередь была полна): {item.skippedEvents}.</>}
          </p>
          {editing === item.id && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await client.webhooks.update(item.id, { events: editEvents });
                  setEditing(null);
                  return "События сохранены.";
                });
              }}
            >
              <EventChoice value={editEvents} onChange={setEditEvents} />
              <div className="webhooks-actions">
                <Button variant="primary" type="submit" disabled={busy || !editEvents.length}>
                  Сохранить
                </Button>
                <Button type="button" onClick={() => setEditing(null)}>
                  Отмена
                </Button>
              </div>
            </form>
          )}
          <div className="webhooks-actions">
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { delivery } = await client.webhooks.ping(item.id);
                  setLog(item.id);
                  return delivery.state === "delivered"
                    ? `Проверка доставлена: HTTP ${delivery.lastStatus}.`
                    : `Проверка не доставлена: ${delivery.lastStatus ? `HTTP ${delivery.lastStatus}` : (ERROR_LABEL[delivery.lastError ?? ""] ?? "ошибка")}.`;
                })
              }
            >
              Проверить
            </Button>
            <Button type="button" onClick={() => setLog(log === item.id ? null : item.id)}>
              {log === item.id ? "Скрыть журнал" : "Журнал доставок"}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(item.id);
                setEditEvents(item.events);
              }}
            >
              События
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await client.webhooks.update(item.id, { enabled: item.status !== "active" });
                  return item.status === "active" ? "Вебхук выключен." : "Вебхук включён.";
                })
              }
            >
              {item.status === "active" ? "Выключить" : "Включить"}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const rotated = await client.webhooks.rotate(item.id);
                  setSecret({ url: item.url, value: rotated.secret });
                })
              }
            >
              Новый секрет
            </Button>
            {confirming === item.id ? (
              <>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    void run(async () => {
                      await client.webhooks.remove(item.id);
                      return "Вебхук удалён вместе с журналом.";
                    });
                  }}
                >
                  Точно удалить
                </Button>
                <Button type="button" onClick={() => setConfirming(null)}>
                  Отмена
                </Button>
              </>
            ) : (
              <Button type="button" disabled={busy} onClick={() => setConfirming(item.id)}>
                Удалить
              </Button>
            )}
          </div>
          {log === item.id && <DeliveryLog key={logVersion} id={item.id} />}
        </article>
      ))}
      {secret && (
        <Notice onDismiss={() => setSecret(null)}>
          Секрет вебхука {secret.url} показывается только сейчас: <code>{secret.value}</code>{" "}
          <CopyButton value={secret.value} />. Прежний секрет больше не подписывает запросы.
        </Notice>
      )}
      <form
        className="webhooks-new"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const made = await client.webhooks.create({ url: url.trim(), description: description.trim(), events });
            setSecret({ url: made.webhook.url, value: made.secret });
            setUrl("");
            setDescription("");
            setEvents(DEFAULT_EVENTS);
          });
        }}
      >
        <h3>Новый вебхук</h3>
        <TextField
          label="Адрес"
          type="url"
          inputMode="url"
          placeholder="https://example.ru/polka-hook"
          hint="Только https:// на порту 443 и адрес в интернете: внутренние сети Полка не вызывает."
          value={url}
          maxLength={2000}
          onChange={(event) => setUrl(event.target.value)}
          required
        />
        <TextField
          label="Описание (необязательно)"
          value={description}
          maxLength={200}
          onChange={(event) => setDescription(event.target.value)}
        />
        <EventChoice value={events} onChange={setEvents} />
        <Button variant="primary" type="submit" disabled={busy || !url.trim() || !events.length}>
          Добавить вебхук
        </Button>
      </form>
      {notice && <p role="status">{notice}</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
