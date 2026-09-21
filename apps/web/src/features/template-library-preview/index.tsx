import React, { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/controls.tsx";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import "./styles.css";

type PreviewTemplate = {
  title: string;
  artifactId: string;
  revisionId: string;
  libraryId: string;
  publicationId: string;
};

type LiveView = { url: string; expiresAt?: string; profile?: string };
type Preparation = {
  revisionId?: string;
  state?: string;
  reason?: string;
  path?: string;
  runtimeProfile?: string;
  concurrent?: boolean;
};
type PreviewResponse = Partial<LiveView> & {
  status?: string;
  message?: string;
  code?: string;
  build?: Preparation | null;
} & Preparation;
class PreviewRequestError extends Error {
  constructor(public status: number, public payload: PreviewResponse) {
    super(payload.message || `Ошибка запуска (${status})`);
  }
}

export function TemplateLibraryPreview({
  template,
  onClose,
}: {
  template: PreviewTemplate;
  onClose: () => void;
}) {
  const [state, setState] = useState<"loading" | "preparation" | "preparing" | "ready" | "error">("loading");
  const [liveView, setLiveView] = useState<LiveView | null>(null);
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [error, setError] = useState("");
  const [retryAction, setRetryAction] = useState<"load" | "prepare" | "none">("load");
  const requestRef = useRef<AbortController | null>(null);

  function startRequest() {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    return controller;
  }

  async function loadLiveView() {
    const controller = startRequest();
    setState("loading");
    setRetryAction("load");
    setLiveView(null);
    setError("");
    try {
      const result = await fetchLiveView(template, controller.signal);
      if (controller.signal.aborted) return;
      setLiveView(result);
      setState("ready");
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof PreviewRequestError && reason.status === 409 && reason.payload.status === "preparation_required") {
        const build = reason.payload.build ?? null;
        setPreparation(build);
        if (build?.state === "unsupported" || build?.state === "failed") {
          setError(preparationError(build));
          setRetryAction(build.state === "failed" ? "prepare" : "none");
          setState("error");
        } else {
          setState("preparation");
        }
      } else {
        setError(previewError(reason));
        setRetryAction(reason instanceof PreviewRequestError && (reason.status === 403 || reason.status === 404) ? "none" : "load");
        setState("error");
      }
    }
  }

  async function prepareLiveView() {
    const controller = startRequest();
    setState("preparing");
    setError("");
    try {
      const result = await requestPreparation(template, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.state) {
        setError("Сервер не вернул состояние подготовки просмотра.");
        setRetryAction("prepare");
        setState("error");
        return;
      }
      setPreparation(result);
      if (result.state === "ready") {
        await loadLiveView();
      } else {
        setState(result.state === "pending" ? "preparation" : "error");
        if (result.state !== "pending") {
          setError(preparationError(result));
          setRetryAction(result.state === "unsupported" ? "none" : "prepare");
        }
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(preparationError(reason));
      setRetryAction(reason instanceof PreviewRequestError && (reason.status === 403 || reason.status === 404) ? "none" : "prepare");
      setState("error");
    }
  }

  useEffect(() => {
    setPreparation(null);
    void loadLiveView();
    return () => requestRef.current?.abort();
  }, [template.libraryId, template.publicationId, template.artifactId, template.revisionId]);

  return (
    <Dialog title={`Предпросмотр: ${template.title}`} onClose={onClose}>
      <div className="template-library-preview-body">
        {state === "loading" && (
          <p className="template-library-preview-status" role="status" aria-live="polite">
            Загружаем предпросмотр…
          </p>
        )}
        {state === "preparing" && (
          <p className="template-library-preview-status" role="status" aria-live="polite">
            Подготавливаем интерактивный просмотр…
          </p>
        )}
        {state === "preparation" && (
          <>
            <div className="template-library-preview-status-block" role="status" aria-live="polite">
              <strong>{preparation?.state === "pending" ? "Подготовка уже выполняется" : "Интерактивный просмотр ещё не подготовлен"}</strong>
              <p>{preparation?.state === "pending" ? "Подождите завершения подготовки и проверьте готовность вручную." : "Подготовьте просмотр для этого выпуска."}</p>
              {preparation?.reason && <p className="fine">{preparation.reason}</p>}
            </div>
            <div className="template-library-preview-actions">
              {preparation?.state === "pending" ? (
                <Button variant="primary" onClick={() => void loadLiveView()}>Проверить готовность</Button>
              ) : (
                <Button variant="primary" onClick={() => void prepareLiveView()}>Подготовить просмотр</Button>
              )}
              <Button onClick={onClose}>Закрыть</Button>
            </div>
          </>
        )}
        {state === "error" && (
          <>
            <ErrorNotice error={error} />
            <div className="template-library-preview-actions">
              {retryAction !== "none" && preparation?.state !== "unsupported" && (
                <Button variant="primary" onClick={() => void (retryAction === "prepare" ? prepareLiveView() : loadLiveView())}>
                  {retryAction === "prepare" ? "Подготовить повторно" : "Повторить"}
                </Button>
              )}
              <Button onClick={onClose}>Закрыть</Button>
            </div>
          </>
        )}
        {state === "ready" && liveView && (
          <>
            <div className="template-library-preview-toolbar">
              <span className="fine">Интерактивный просмотр</span>
              <Button onClick={() => void loadLiveView()}>Обновить просмотр</Button>
            </div>
            <iframe
              className="template-library-preview-frame"
              title={`Предпросмотр шаблона «${template.title}»`}
              src={liveView.url}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          </>
        )}
      </div>
    </Dialog>
  );
}

function previewError(reason: unknown) {
  if (reason instanceof PreviewRequestError) {
    if (reason.status === 403) return "У вас больше нет доступа к этому выпуску.";
    if (reason.status === 404)
      return "Этот выпуск больше недоступен в общей библиотеке.";
    if (reason.status === 413 || reason.status === 429 || reason.payload.code === "quota" || reason.payload.status === "quota" || reason.payload.reason === "quota")
      return "Достигнут лимит подготовки просмотров. Повторите позже.";
    return reason.message || "Не удалось загрузить предпросмотр.";
  }
  return reason instanceof Error && reason.message
    ? reason.message
    : "Не удалось загрузить предпросмотр.";
}

function preparationError(reason: unknown) {
  if (reason && typeof reason === "object" && "state" in reason) {
    const preparation = reason as Preparation;
    if (preparation.state === "unsupported" || preparation.reason === "unsupported")
      return "Этот материал нельзя подготовить для интерактивного просмотра.";
    if (preparation.state === "failed")
      return preparation.reason || "Не удалось подготовить просмотр.";
  }
  if (reason instanceof PreviewRequestError) {
    if (reason.status === 403) return "У вас больше нет доступа к этому выпуску.";
    if (reason.status === 404) return "Этот выпуск больше недоступен в общей библиотеке.";
    if (reason.status === 413 || reason.status === 429 || reason.payload.code === "quota" || reason.payload.status === "quota" || reason.payload.reason === "quota")
      return "Достигнут лимит подготовки просмотров. Повторите позже.";
    if (reason.payload.state === "unsupported" || reason.payload.reason === "unsupported")
      return "Этот материал нельзя подготовить для интерактивного просмотра.";
    return reason.message || "Не удалось подготовить просмотр.";
  }
  return reason instanceof Error && reason.message ? reason.message : "Не удалось подготовить просмотр.";
}

async function requestPreparation(template: PreviewTemplate, signal: AbortSignal): Promise<Preparation> {
  const response = await fetch(
    `/api/template-libraries/${template.libraryId}/publications/${template.publicationId}/prepare-live-view`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: template.artifactId, revisionId: template.revisionId }),
      signal,
    },
  );
  let payload: PreviewResponse = {};
  try {
    const result: unknown = await response.json();
    if (result && typeof result === "object") payload = result as PreviewResponse;
  } catch {
    // Keep the HTTP status when the response has no JSON body.
  }
  if (!response.ok) throw new PreviewRequestError(response.status, payload);
  return payload;
}

async function fetchLiveView(template: PreviewTemplate, signal: AbortSignal): Promise<LiveView> {
  const response = await fetch(
    `/api/template-libraries/${template.libraryId}/publications/${template.publicationId}/live-view`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: template.artifactId, revisionId: template.revisionId }),
      signal,
    },
  );
  let payload: PreviewResponse = {};
  try {
    const result: unknown = await response.json();
    if (result && typeof result === "object") payload = result as PreviewResponse;
  } catch {
    // Keep the HTTP status when the response has no JSON body.
  }
  if (!response.ok) throw new PreviewRequestError(response.status, payload);
  if (typeof payload.url !== "string" || !payload.url.trim())
    throw new Error("Сервер не вернул адрес предпросмотра.");
  return { url: payload.url, expiresAt: payload.expiresAt, profile: payload.profile };
}
