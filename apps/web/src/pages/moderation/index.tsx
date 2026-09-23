import React, { useEffect, useRef, useState } from "react";
import { Check, Eye, ShieldAlert } from "lucide-react";
import type { Viewer } from "../../../../../packages/contracts/index.ts";
import {
  ApiError,
  client,
  type ModerationInspection,
} from "../../shared/api/client.ts";
import { Button, Notice } from "../../shared/ui/controls.tsx";
import { Preview } from "../../widgets/artifact-preview/index.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import "./styles.css";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; details: ModerationInspection };

const STATE_LABEL: Record<ModerationInspection["share"]["state"], string> = {
  none: "открыта для получателей",
  held: "ждёт проверки",
  paused: "приостановлена после жалоб",
  blocked: "заблокирована",
  closed: "закрыта или истекла",
};

const date = (value: string) =>
  new Date(value).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

const failure = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : "Не удалось связаться с Полкой. Повторите попытку.";

/**
 * The operator's confirmation page for a button in a moderation letter.
 * Opening it only reads (mail scanners open links on their own); the action
 * runs when the operator presses the button.
 */
export function Moderation() {
  const account = useAccount();
  const token = useRef(location.hash.slice(1)).current;
  const [state, setState] = useState<State>(() =>
    token
      ? { kind: "loading" }
      : {
          kind: "error",
          message:
            "Эта страница открывается кнопкой из письма модерации Полки.",
        },
  );
  const [preview, setPreview] = useState<Viewer | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ message: string; changed: boolean } | null>(
    null,
  );
  const [actError, setActError] = useState<string | null>(null);
  // «Заблокировать»: keep the content as evidence, decided before the block.
  const [legalHold, setLegalHold] = useState(false);
  const [authority, setAuthority] = useState("");

  const load = () =>
    client.moderation
      .inspect(token)
      .then((details) => setState({ kind: "ready", details }))
      .catch((error) => setState({ kind: "error", message: failure(error) }));

  useEffect(() => {
    if (state.kind === "loading") void load();
  }, []);

  const showPreview = async () => {
    setPreviewError(null);
    try {
      setPreview(await client.moderation.preview(token));
    } catch (error) {
      setPreviewError(failure(error));
    }
  };

  const act = async () => {
    setBusy(true);
    setActError(null);
    try {
      const outcome = await client.moderation.act(
        token,
        state.kind === "ready" && state.details.action === "block"
          ? { legalHold, authority: authority.trim() || undefined }
          : {},
      );
      setDone(outcome);
      await load();
    } catch (error) {
      setActError(failure(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell current="shelf" account={account} className="moderation-page">
      <main className="moderation">
        {state.kind === "loading" && (
          <p role="status" className="moderation-card">
            Проверяем ссылку из письма…
          </p>
        )}
        {state.kind === "error" && (
          <section className="moderation-card">
            <h1>Действие недоступно</h1>
            <Notice tone="error">{state.message}</Notice>
          </section>
        )}
        {state.kind === "ready" && (
          <section className="moderation-card">
            <p className="moderation-eyebrow">
              <ShieldAlert aria-hidden="true" /> Модерация Полки
            </p>
            <h1>
              {state.details.action === "preview"
                ? "Просмотр ссылки"
                : state.details.actionLabel}
            </h1>
            <dl className="moderation-facts">
              <dt>Работа</dt>
              <dd>
                «{state.details.share.title}», версия{" "}
                {state.details.share.version}
              </dd>
              <dt>Автор</dt>
              <dd>
                {state.details.author.label}
                {state.details.author.operatorCreated
                  ? " · создан оператором"
                  : ""}
                {" · "}
                {state.details.author.createdAt
                  ? `с ${date(state.details.author.createdAt)}`
                  : "аккаунт старше 23.09.2026"}
                {" · "}
                {state.details.author.disabled
                  ? "отключён"
                  : state.details.author.trusted
                    ? "доверенный"
                    : "новый"}
              </dd>
              <dt>Ссылка</dt>
              <dd>{STATE_LABEL[state.details.share.state]}</dd>
              {state.details.share.signals && (
                <>
                  <dt>Признаки</dt>
                  <dd>{state.details.share.signals}</dd>
                </>
              )}
              {state.details.reports.length > 0 && (
                <>
                  <dt>Жалобы</dt>
                  <dd>
                    <ul className="moderation-reports">
                      {state.details.reports.map((report, index) => (
                        <li key={index}>
                          {report.reason}
                          {report.comment ? ` — «${report.comment}»` : ""}
                          <small>
                            {" "}
                            {date(report.createdAt)}
                            {report.settled ? " · рассмотрена" : ""}
                          </small>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
            </dl>
            {state.details.share.content && (
              <p className="moderation-effect">
                Фильтр содержимого: {state.details.share.content}
              </p>
            )}
            <p className="moderation-effect">{state.details.effect}</p>
            {state.details.action === "block" && !done && (
              <div className="moderation-hold">
                <label>
                  <input
                    type="checkbox"
                    checked={legalHold}
                    onChange={(event) => setLegalHold(event.target.checked)}
                  />{" "}
                  Сохранить как доказательство (legal hold): не удалять, пока
                  удержание не снято
                </label>
                {legalHold && (
                  <label>
                    Основание (запрос органа, номер){" "}
                    <input
                      type="text"
                      maxLength={500}
                      value={authority}
                      onChange={(event) => setAuthority(event.target.value)}
                    />
                  </label>
                )}
              </div>
            )}
            {done && (
              <Notice>
                <Check aria-hidden="true" /> {done.message}
              </Notice>
            )}
            {actError && <Notice tone="error">{actError}</Notice>}
            <div className="moderation-actions">
              {state.details.action !== "preview" && !done && (
                <Button variant="primary" busy={busy} onClick={() => void act()}>
                  {state.details.actionLabel}
                </Button>
              )}
              {!preview &&
                !state.details.share.csam &&
                state.details.share.state !== "blocked" && (
                <Button onClick={() => void showPreview()} disabled={busy}>
                  <Eye aria-hidden="true" /> Посмотреть страницу
                </Button>
              )}
            </div>
            <p className="moderation-fine">
              Открытие этой страницы ничего не меняет. Кнопка действует до{" "}
              {date(state.details.tokenExpiresAt)}; повторное нажатие безопасно.
            </p>
            {previewError && <Notice tone="error">{previewError}</Notice>}
          </section>
        )}
        {preview && (
          <section
            className="stage moderation-preview"
            data-kind={
              preview.revision.mime === "text/plain"
                ? "text"
                : preview.revision.mime.startsWith("image/")
                  ? "image"
                  : "page"
            }
            aria-label="Предпросмотр как у получателя"
          >
            <Preview
              revision={preview.revision}
              grant={preview.grant}
              readingTitle={
                preview.revision.mime === "text/plain"
                  ? preview.title
                  : undefined
              }
            />
          </section>
        )}
      </main>
    </AppShell>
  );
}
