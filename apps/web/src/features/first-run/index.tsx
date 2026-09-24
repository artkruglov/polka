import React, { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Bot, Check, Link2, Upload } from "lucide-react";
import type {
  Account,
  Artifact,
  Receipt,
} from "../../../../../packages/contracts/index.ts";
import { Button, LinkButton } from "../../shared/ui/controls.tsx";
import { ErrorNotice } from "../../shared/ui/index.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import {
  deriveFirstRun,
  firstRunTitles,
  type FirstRunModel,
  type FirstRunStepId,
} from "../../entities/onboarding/steps.ts";
import { clientHints, connectPhrase } from "../../entities/onboarding/connect-phrase.ts";
import {
  harvestClient,
  readStoredClient,
  storeClient,
  type HarvestClientId,
} from "../../entities/onboarding/agent-setup.ts";
import { HarvestPrompt } from "../../entities/onboarding/HarvestPrompt.tsx";
import { arrivedFromShare } from "../../entities/onboarding/arrival.ts";
import { writeDismissed } from "../../entities/onboarding/dismissal.ts";
import { useFirstRun } from "../../entities/onboarding/useFirstRun.ts";
import {
  SAMPLE_FILENAME,
  SAMPLE_TITLE,
  sampleBlob,
} from "../../entities/onboarding/sample-page.ts";
import { useSaveUpload } from "../../entities/artifact/useSaveUpload.ts";

type Status = "loading" | "ready" | "error";

export type FirstRunStepsProps = {
  model: FirstRunModel;
  origin: string;
  /** card: on the shelf, with «Скрыть»; page: /start, the page owns the heading. */
  variant: "card" | "page";
  connections: { status: Status; error?: string; retry: () => void };
  works: { status: Status; error?: string; retry: () => void };
  sample: {
    busy: boolean;
    stage: string;
    error: string;
    retrying: boolean;
    saved: { id: string; title: string } | null;
    save: () => void;
  };
  /** What the live region says right now. */
  announcement: string;
  /** Whose harvest task step 2 shows; the tabs switch it. */
  client: HarvestClientId;
  onClient: (id: HarvestClientId) => void;
  onShare?: (work: Artifact) => void;
  onDismiss?: () => void;
  /** On the shelf: «Загрузить файл» opens the upload panel; /start links to /bring. */
  onUpload?: () => void;
  /**
   * share: the person came from someone's shared work (entities/onboarding/
   * arrival.ts). The agent phrase leads, because that is what they saw made.
   */
  arrival?: "share";
};

const stepText: Record<FirstRunStepId, string> = {
  agent:
    "Скажите агенту фразу ниже. Он выполнит одну команду, Полка откроется в браузере, вы нажмёте «Разрешить». Токен не нужен.",
  save: "Скопируйте задание агенту: он найдёт ваши лучшие работы, покажет список и после вашего «да» сохранит их на Полку. Или загрузите файл сами.",
  share:
    "Ссылка открывает зафиксированную версию, получателю не нужен аккаунт. Срок 1, 7 или 30 дней; закрыть можно в любой момент.",
};

/** Presentation only: every «done» comes from the model, never from a click. */
export function FirstRunSteps({
  model,
  origin,
  variant,
  connections,
  works,
  sample,
  announcement,
  client,
  onClient,
  onShare,
  onDismiss,
  onUpload,
  arrival,
}: FirstRunStepsProps) {
  const phrase = connectPhrase(origin);
  const hints = clientHints(origin);
  const busy = connections.status === "loading" || works.status === "loading";
  const titleId = "first-run-title";
  const [agent, save, share] = model.steps;
  const tone = (id: FirstRunStepId) => (model.next === id ? "primary" : "secondary");
  const fromShare = arrival === "share" && !agent.done;
  return (
    <section
      className={`first-run first-run--${variant}`}
      aria-labelledby={titleId}
      data-complete={model.complete || undefined}
      data-arrival={arrival}
    >
      <header className="first-run-head">
        <div className="first-run-heading">
          <span className="eyebrow">{fromShare ? "Вы пришли по ссылке с Полки" : "Первые шаги"}</span>
          <h2 id={titleId} className={variant === "page" ? "sr-only" : undefined}>
            {model.complete
              ? "Готово: агент, работа, ссылка"
              : fromShare
                ? "Подключите агента — и он будет сохранять работы сам"
                : "Три шага до первой ссылки"}
          </h2>
        </div>
        <span className="first-run-progress" aria-label={`Выполнено ${model.done} из ${model.total}`}>
          {model.done} из {model.total}
        </span>
        {variant === "card" && onDismiss && (
          <Button variant="quiet" className="first-run-dismiss" onClick={onDismiss}>
            Скрыть
          </Button>
        )}
      </header>
      <div className="first-run-bar" aria-hidden="true">
        <i style={{ width: `${(model.done / model.total) * 100}%` }} />
      </div>
      {model.complete && (
        <p className="first-run-complete">
          Дальше просто просите агента сохранять работы на Полку. Подключения и ссылки всегда видны здесь.
        </p>
      )}
      <ol className="first-run-steps" aria-busy={busy || undefined}>
        {model.steps.map((step, index) => (
          <li
            key={step.id}
            className="first-run-step"
            data-done={step.done || undefined}
            aria-current={model.next === step.id ? "step" : undefined}
          >
            <span className="first-run-mark" aria-hidden="true">
              {step.done ? <Check /> : index + 1}
            </span>
            <div className="first-run-body">
              <h3>
                <span className="sr-only">{step.done ? "Выполнено: " : `Шаг ${index + 1}: `}</span>
                {firstRunTitles[step.id]}
              </h3>
              {step.done ? (
                <p className="first-run-note">{step.note}</p>
              ) : (
                <p className="first-run-text">{stepText[step.id]}</p>
              )}

              {step.id === "agent" && !step.done && (
                <>
                  <div className="first-run-phrase">
                    <code>{phrase}</code>
                    <CopyButton
                      value={phrase}
                      label="Скопировать фразу"
                      successText="Фраза скопирована"
                      variant={tone("agent")}
                    />
                  </div>
                  <details className="first-run-hints">
                    <summary>Команды для Codex, Claude Code, Claude.ai и ChatGPT</summary>
                    <dl>
                      {hints.map((hint) => (
                        <div key={hint.id}>
                          <dt>{hint.client}</dt>
                          <dd>
                            {hint.command && (
                              <pre>
                                <code>{hint.command}</code>
                              </pre>
                            )}
                            <span>{hint.note}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                  <p className="first-run-links">
                    <a href="/settings/agents">
                      <Bot /> Все способы подключения
                    </a>
                    {connections.status === "loading" ? (
                      <span role="status">Проверяем подключения…</span>
                    ) : connections.status === "error" ? (
                      <span role="alert">
                        Не удалось проверить подключения.{" "}
                        <button type="button" className="text-button" onClick={connections.retry}>
                          Повторить
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="text-button" onClick={connections.retry}>
                        Проверить подключение
                      </button>
                    )}
                  </p>
                </>
              )}
              {step.id === "agent" && step.done && (
                <p className="first-run-links">
                  <a href="/settings/agents">
                    <Bot /> Подключения
                  </a>
                </p>
              )}

              {step.id === "save" && !step.done && (
                <>
                  <HarvestPrompt
                    client={client}
                    onClient={onClient}
                    primary={model.next === "save"}
                  />
                  <div className="first-run-action">
                    {onUpload ? (
                      <Button onClick={onUpload}>
                        <Upload /> Загрузить файл
                      </Button>
                    ) : (
                      <LinkButton href="/bring">
                        <Upload /> Загрузить файл
                      </LinkButton>
                    )}
                    {!sample.saved && (
                      <Button variant="quiet" busy={sample.busy} onClick={sample.save}>
                        {sample.stage || (sample.retrying ? "Повторить сохранение" : "Сохранить пример")}
                      </Button>
                    )}
                    {works.status === "error" && (
                      <span role="alert" className="first-run-problem">
                        Не удалось загрузить полку.{" "}
                        <button type="button" className="text-button" onClick={works.retry}>
                          Повторить
                        </button>
                      </span>
                    )}
                  </div>
                  <ErrorNotice error={sample.error} />
                  {sample.saved && (
                    <p className="first-run-saved" role="status">
                      <Check /> Пример сохранён: «{sample.saved.title}». Пока его видите только вы.{" "}
                      <a href={`/works/${sample.saved.id}`}>
                        Открыть <ArrowUpRight />
                      </a>
                    </p>
                  )}
                </>
              )}
              {step.id === "save" && step.done && model.agentSaved && (
                <p className="first-run-text">Агент подключён и уже обращался к Полке.</p>
              )}

              {step.id === "share" && !step.done && model.shareTarget && (
                <div className="first-run-action">
                  {onShare ? (
                    <Button variant={tone("share")} onClick={() => onShare(model.shareTarget!)}>
                      <Link2 /> Поделиться
                    </Button>
                  ) : (
                    <LinkButton
                      variant={tone("share")}
                      href={`/works/${model.shareTarget.id}?panel=share`}
                    >
                      <Link2 /> Поделиться
                    </LinkButton>
                  )}
                  <span className="first-run-target">«{model.shareTarget.title}»</span>
                </div>
              )}
              {step.id === "share" && !step.done && !model.shareTarget && (
                <p className="first-run-note">
                  {step.note ?? "Появится после первой работы."}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}

/**
 * Data and behaviour: connections and works from the API, the one-click
 * example through the ordinary upload, the dismissal in this browser, and a
 * live-region sentence whenever a step becomes done during the session.
 */
export function FirstRunChecklist({
  account,
  works,
  variant,
  onSaved,
  onShare,
  onDismiss,
  onUpload,
}: {
  account: Account;
  /** The shelf passes what it shows; omitted on /start. */
  works?: { items: Artifact[]; loading: boolean };
  variant: "card" | "page";
  onSaved?: (receipt: Receipt) => void;
  onShare?: (work: Artifact) => void;
  onDismiss?: () => void;
  onUpload?: () => void;
}) {
  const data = useFirstRun({ accountId: account.id, provided: works });
  // Read once: the tab's source does not change while the shelf is open.
  const [arrival] = useState<"share" | undefined>(() =>
    arrivedFromShare() ? "share" : undefined,
  );
  // The client chosen on the agents page; switching here remembers it too.
  const [client, setClient] = useState<HarvestClientId>(() =>
    harvestClient(readStoredClient()),
  );
  const upload = useSaveUpload();
  const model = deriveFirstRun({
    connections: data.connections.value,
    works: data.works.value,
  });
  const [announcement, setAnnouncement] = useState("");
  const settled =
    data.connections.status !== "loading" && data.works.status !== "loading";
  const previous = useRef<Record<FirstRunStepId, boolean> | null>(null);
  useEffect(() => {
    if (!settled) return;
    const current = Object.fromEntries(
      model.steps.map((s) => [s.id, s.done]),
    ) as Record<FirstRunStepId, boolean>;
    if (previous.current) {
      const finished = model.steps.filter(
        (s) => s.done && !previous.current![s.id],
      );
      if (finished.length)
        setAnnouncement(
          model.complete
            ? "Все три шага выполнены."
            : `Шаг выполнен: ${finished.map((s) => firstRunTitles[s.id]).join(", ")}. ${model.done} из ${model.total}.`,
        );
    }
    previous.current = current;
  }, [settled, model.done, model.complete]);

  const reported = useRef<string | null>(null);
  useEffect(() => {
    const saved = upload.saved;
    if (!saved || reported.current === saved.receipt.uploadId) return;
    reported.current = saved.receipt.uploadId;
    setAnnouncement(`Пример сохранён: «${SAMPLE_TITLE}». Пока его видите только вы.`);
    onSaved?.(saved.receipt);
    data.reloadWorks();
  }, [upload.saved]);

  const saveSample = () =>
    void upload.save(sampleBlob(), {
      title: SAMPLE_TITLE,
      filename: SAMPLE_FILENAME,
      folderId: null,
    });

  return (
    <FirstRunSteps
      model={model}
      origin={location.origin}
      variant={variant}
      connections={{
        status: data.connections.status,
        error: data.connections.status === "error" ? data.connections.error : undefined,
        retry: data.reloadConnections,
      }}
      works={{
        status: data.works.status,
        error: data.works.status === "error" ? data.works.error : undefined,
        retry: data.reloadWorks,
      }}
      sample={{
        busy: upload.busy,
        stage: upload.stage,
        error: upload.error,
        retrying: upload.retrying,
        saved: upload.saved
          ? { id: upload.saved.receipt.artifactId, title: SAMPLE_TITLE }
          : null,
        save: saveSample,
      }}
      announcement={announcement}
      client={client}
      onClient={(id) => {
        setClient(id);
        storeClient(id);
      }}
      onShare={onShare}
      onUpload={onUpload}
      arrival={arrival}
      onDismiss={
        onDismiss
          ? () => {
              writeDismissed(account.id, true);
              onDismiss();
            }
          : undefined
      }
    />
  );
}
