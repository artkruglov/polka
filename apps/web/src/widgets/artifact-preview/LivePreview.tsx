import { Button } from "../../shared/ui/controls.tsx";
import { CircleStop, Maximize2, Minimize2, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { Revision } from "../../../../../packages/contracts/index.ts";
import {
  isLive,
  nextLiveSteps,
  type CapabilityState,
  type LiveMode,
} from "./live-plan.ts";

const modeLabel: Record<LiveMode, string> = {
  production: "Интерактивная версия",
  staging: "Тестовый интерактивный просмотр",
  local: "Локальная проверка",
};

type LiveView = {
  url: string;
  expiresAt?: string;
  profile?: string;
};
type InlineBuild = NonNullable<Revision["inlineBuild"]>;

// The profile of a live view that runs the saved upload itself, not a build.
const UPLOAD_PROFILE = "inline-live-experimental-v1";
// Keep in sync with LIVE_VIEWER_SANDBOX on the server: scripts and the
// page's own submit handlers; no popups, dialogs, top navigation or origin.
const LIVE_SANDBOX = "allow-scripts allow-forms";

function messageFor(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "Интерактивную версию не удалось запустить.";
}

async function readError(response: Response) {
  try {
    const result = (await response.json()) as { message?: string };
    return result.message || `Ошибка запуска (${response.status})`;
  } catch {
    return `Ошибка запуска (${response.status})`;
  }
}

async function readBuild(
  path: string,
  method: "GET" | "POST",
  signal: AbortSignal,
) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as InlineBuild | null;
}

export function LivePreview({
  revision,
  grant,
  requiresBuild = false,
  buildForLink = false,
  onInlineBuildChange,
  overlay,
  children,
}: {
  revision: Revision;
  grant?: string;
  requiresBuild?: boolean;
  buildForLink?: boolean;
  onInlineBuildChange?: () => Promise<void>;
  /** Comments: the grant is asked for with the overlay; see Preview. */
  overlay?: { onFrame: (frame: HTMLIFrameElement | null) => void };
  children: ReactNode;
}) {
  const [capability, setCapability] = useState<CapabilityState>("loading");
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [live, setLive] = useState<LiveView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [build, setBuild] = useState<InlineBuild | null>(
    revision.inlineBuild ?? null,
  );
  const [buildBusy, setBuildBusy] = useState(false);
  const [pollPaused, setPollPaused] = useState("");
  const [expanded, setExpanded] = useState(false);
  // Opened automatically once per revision; a stop returns to the static view.
  const [stopped, setStopped] = useState(false);
  const autoLaunched = useRef(false);
  const autoPrepared = useRef(false);
  const relaunchedForBuild = useRef(false);
  const launchAbort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const buildAbort = useRef<AbortController | null>(null);
  const expandedContainer = useRef<HTMLDivElement | null>(null);
  const collapseButton = useRef<HTMLButtonElement | null>(null);
  const focusBeforeExpand = useRef<HTMLElement | null>(null);
  const onBuildChangeRef = useRef(onInlineBuildChange);
  onBuildChangeRef.current = onInlineBuildChange;

  useEffect(() => {
    const abort = new AbortController();
    const currentGeneration = ++generation.current;
    launchAbort.current?.abort();
    launchAbort.current = null;
    setCapability("loading");
    setLive(null);
    setExpanded(false);
    setBusy(false);
    setBuildBusy(false);
    setError("");
    setPollPaused("");
    setStopped(false);
    autoLaunched.current = false;
    autoPrepared.current = false;
    relaunchedForBuild.current = false;
    setBuild(revision.inlineBuild ?? null);
    return () => {
      abort.abort();
      launchAbort.current?.abort();
      launchAbort.current = null;
      buildAbort.current?.abort();
      buildAbort.current = null;
    };
  }, [revision.id, grant]);

  useEffect(() => {
    if (!expanded) return;
    focusBeforeExpand.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const previousInert = new Map<
      HTMLElement,
      { had: boolean; value: string | null }
    >();
    const markBackground = (element: Node) => {
      if (!(element instanceof HTMLElement)) return;
      if (!previousInert.has(element)) {
        previousInert.set(element, {
          had: element.hasAttribute("inert"),
          value: element.getAttribute("inert"),
        });
      }
      element.setAttribute("inert", "");
    };
    const paths: Array<{ ancestor: HTMLElement; branch: HTMLElement }> = [];
    let branch: HTMLElement | null = expandedContainer.current;
    while (branch?.parentElement) {
      const ancestor = branch.parentElement;
      paths.push({ ancestor, branch });
      for (const child of Array.from(ancestor.children)) {
        if (child !== branch) markBackground(child);
      }
      if (ancestor === document.body) break;
      branch = ancestor;
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const path = paths.find(({ ancestor }) => ancestor === record.target);
        if (!path) continue;
        for (const node of Array.from(record.addedNodes)) {
          if (node !== path.branch) markBackground(node);
        }
      }
    });
    for (const { ancestor } of paths)
      observer.observe(ancestor, { childList: true });
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const focusFrame = requestAnimationFrame(() =>
      collapseButton.current?.focus(),
    );
    return () => {
      cancelAnimationFrame(focusFrame);
      observer.disconnect();
      for (const [element, previous] of previousInert) {
        if (previous.had) element.setAttribute("inert", previous.value ?? "");
        else element.removeAttribute("inert");
      }
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      if (focusBeforeExpand.current?.isConnected)
        focusBeforeExpand.current.focus();
      focusBeforeExpand.current = null;
    };
  }, [expanded]);

  useEffect(() => {
    const abort = new AbortController();
    const currentGeneration = generation.current;
    fetch("/api/capabilities", { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response));
        const result = (await response.json()) as {
          liveExperimental?: unknown;
          liveMode?: unknown;
        };
        if (!abort.signal.aborted && generation.current === currentGeneration)
          setCapability(
            result.liveExperimental !== true
              ? "disabled"
              : result.liveMode === "staging" ||
                  result.liveMode === "production"
                ? result.liveMode
                : result.liveMode === "local" || result.liveMode === undefined
                  ? "local"
                  : "disabled",
          );
      })
      .catch((reason) => {
        if (!abort.signal.aborted && generation.current === currentGeneration) {
          setCapability("error");
          setError(messageFor(reason));
        }
      });
    return () => abort.abort();
  }, [revision.id, grant, capabilityAttempt]);

  useEffect(() => {
    if (
      (!requiresBuild && !buildForLink) ||
      grant ||
      !isLive(capability) ||
      build?.state !== "pending" ||
      pollPaused
    )
      return;
    const abort = new AbortController();
    buildAbort.current?.abort();
    buildAbort.current = abort;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (abort.signal.aborted) return;
      if (++attempts > 20) {
        setPollPaused("Проверка заняла слишком много времени.");
        return;
      }
      try {
        const next = await readBuild(
          `/revisions/${revision.id}/build-inline`,
          "GET",
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (!next || next.state !== "pending") {
          setBuild(
            next ?? {
              state: "failed",
              runtimeProfile: null,
              reason: "Сервер не вернул состояние подготовки.",
              path: null,
            },
          );
          setPollPaused("");
          if (next && onBuildChangeRef.current)
            await onBuildChangeRef.current();
          return;
        }
        timer = setTimeout(poll, 500);
      } catch (reason) {
        if (!abort.signal.aborted) setPollPaused(messageFor(reason));
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
      if (buildAbort.current === abort) buildAbort.current = null;
    };
  }, [
    build?.state,
    buildForLink,
    capability,
    grant,
    pollPaused,
    requiresBuild,
    revision.id,
  ]);

  const prepare = async () => {
    const abort = new AbortController();
    buildAbort.current?.abort();
    buildAbort.current = abort;
    setBuildBusy(true);
    setError("");
    try {
      const next = await readBuild(
        `/revisions/${revision.id}/build-inline`,
        "POST",
        abort.signal,
      );
      if (!abort.signal.aborted) {
        setBuild(
          next ?? {
            state: "failed",
            runtimeProfile: null,
            reason: "Сервер не вернул состояние подготовки.",
            path: null,
          },
        );
        setPollPaused("");
        if (next?.state !== "pending" && onBuildChangeRef.current)
          await onBuildChangeRef.current();
      }
    } catch (reason) {
      if (!abort.signal.aborted) setError(messageFor(reason));
    } finally {
      if (buildAbort.current === abort) buildAbort.current = null;
      if (!abort.signal.aborted) setBuildBusy(false);
    }
  };

  const launch = async () => {
    const currentGeneration = generation.current;
    const abort = new AbortController();
    launchAbort.current?.abort();
    launchAbort.current = abort;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        grant
          ? "/api/view/live-view"
          : `/api/revisions/${revision.id}/live-view`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            ...(grant ? { Authorization: `Bearer ${grant}` } : {}),
            ...(overlay ? { "Content-Type": "application/json" } : {}),
          },
          body: overlay ? JSON.stringify({ comments: true }) : undefined,
          signal: abort.signal,
        },
      );
      if (!response.ok) throw new Error(await readError(response));
      const result = (await response.json()) as Partial<LiveView>;
      if (typeof result.url !== "string" || !result.url)
        throw new Error("Сервер не вернул адрес интерактивной версии.");
      if (!abort.signal.aborted && generation.current === currentGeneration)
        setLive({
          url: result.url,
          expiresAt: result.expiresAt,
          profile: result.profile,
        });
    } catch (reason) {
      if (!abort.signal.aborted && generation.current === currentGeneration)
        setError(messageFor(reason));
    } finally {
      // A launch superseded by a newer one must not re-enable the button
      // while that newer launch is still running.
      if (launchAbort.current === abort) {
        launchAbort.current = null;
        if (generation.current === currentGeneration) setBusy(false);
      }
    }
  };

  const stop = () => {
    setExpanded(false);
    setLive(null);
    setStopped(true);
  };

  useEffect(() => {
    const steps = nextLiveSteps({
      capability,
      requiresBuild,
      buildForLink,
      build: build?.state ?? null,
      owner: !grant,
      stopped,
      launched: autoLaunched.current,
      prepared: autoPrepared.current,
    });
    if (steps.includes("launch")) {
      autoLaunched.current = true;
      void launch();
    }
    if (steps.includes("prepare")) {
      autoPrepared.current = true;
      void prepare();
    }
  }, [build?.state, buildForLink, capability, grant, requiresBuild, stopped]);

  // The owner's upload was running while its build was prepared: switch to
  // the built version, which is what a link recipient sees. Once only.
  useEffect(() => {
    if (
      build?.state !== "ready" ||
      live?.profile !== UPLOAD_PROFILE ||
      grant ||
      stopped ||
      relaunchedForBuild.current
    )
      return;
    relaunchedForBuild.current = true;
    void launch();
  }, [build?.state, live?.profile, grant, stopped]);

  // A ready build may list what it left out (remote fonts, images, hints).
  const builtNote =
    build?.state === "ready" && build.reason ? (
      <p className="html-preview-note">{build.reason}.</p>
    ) : null;
  // A single upload runs as is for its owner, but its link needs the build.
  const linkNote =
    !grant &&
    buildForLink &&
    (build?.state === "unsupported" || build?.state === "failed") ? (
      <p className="html-preview-note">
        Ссылка на интерактивную версию пока невозможна: её не удалось
        подготовить.
        {build.reason ? ` Причина: ${build.reason}.` : ""}
        {build.path ? ` Файл: ${build.path}.` : ""}{" "}
        {build.state === "failed" && (
          <Button
            type="button"
            variant="quiet"
            onClick={prepare}
            busy={buildBusy}
          >
            Повторить подготовку
          </Button>
        )}
      </p>
    ) : null;

  if (capability === "disabled") return <>{children}</>;

  if (live)
    return (
      <div
        className={`html-preview${expanded ? " html-preview-expanded" : ""}`}
        ref={expandedContainer}
      >
        {/* A recipient's toolbar stays one row on a phone: the buttons keep
            their icons and accessible names, the words show from 761px. */}
        <div
          className={`html-preview-note html-preview-toolbar${grant ? " html-preview-toolbar--compact" : ""}`}
        >
          <span title="Код страницы выполняется в изолированной песочнице на отдельном домене, без сети. Не вводите здесь конфиденциальные данные.">
            {isLive(capability) ? modeLabel[capability] : ""}
          </span>{" "}
          <Button
            type="button"
            variant="quiet"
            ref={collapseButton}
            aria-label={expanded ? "Свернуть" : "Развернуть"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            <span className="html-preview-toolbar-label">
              {expanded ? "Свернуть" : "Развернуть"}
            </span>
          </Button>
          <Button
            type="button"
            variant="quiet"
            onClick={stop}
            aria-label="Остановить"
            title="Остановить и показать сохранённую статичную версию"
          >
            <CircleStop aria-hidden="true" />
            <span className="html-preview-toolbar-label">Остановить</span>
          </Button>
          {grant && (
            <Button
              type="button"
              variant="quiet"
              aria-label="Обновить доступ"
              title="Обновить доступ к просмотру"
              onClick={() => location.reload()}
            >
              <RotateCw aria-hidden="true" />
              <span className="html-preview-toolbar-label">Обновить доступ</span>
            </Button>
          )}
        </div>
        {live.profile !== UPLOAD_PROFILE && builtNote}
        {linkNote}
        <iframe
          className="work-html"
          title={revision.filename}
          src={live.url}
          sandbox={LIVE_SANDBOX}
          ref={overlay?.onFrame}
          referrerPolicy="no-referrer"
        />
      </div>
    );

  return (
    <>
      {children}
      {capability === "loading" && (
        <p className="html-preview-note">
          Проверяем доступность интерактивного эксперимента…
        </p>
      )}
      {capability === "error" && (
        <p className="html-preview-note">
          {error}{" "}
          <Button
            type="button"
            variant="quiet"
            onClick={() => setCapabilityAttempt((attempt) => attempt + 1)}
          >
            Повторить
          </Button>
        </p>
      )}
      {isLive(capability) && requiresBuild && build?.state !== "ready" && (
        <div className="html-preview-note">
          {error && <p className="preview-error">{error}</p>}
          {build?.state === "pending" ? (
            <>
              <p role="status">
                {pollPaused ||
                  "Подготавливаем интерактивную версию. Она откроется здесь сама."}
              </p>
              {pollPaused && (
                <Button
                  type="button"
                  variant="quiet"
                  onClick={prepare}
                  busy={buildBusy}
                >
                  {buildBusy ? "Повторяем подготовку…" : "Повторить подготовку"}
                </Button>
              )}
            </>
          ) : build?.state === "unsupported" || build?.state === "failed" ? (
            <p className="preview-error">
              Интерактивную версию не удалось подготовить.
              {build.reason ? ` Причина: ${build.reason}.` : ""}
              {build.path ? ` Файл: ${build.path}.` : ""}
            </p>
          ) : null}
          {!grant && (
            <Button
              type="button"
              variant="secondary"
              onClick={prepare}
              busy={buildBusy}
              disabled={build?.state === "pending"}
            >
              {buildBusy
                ? "Подготавливаем…"
                : build?.state
                  ? "Повторить подготовку"
                  : "Подготовить интерактивную версию"}
            </Button>
          )}
        </div>
      )}
      {isLive(capability) && (!requiresBuild || build?.state === "ready") && (
        <div className="html-preview-note">
          <p>
            {capability === "production"
              ? "Интерактивная версия."
              : capability === "staging"
                ? "Тестовый просмотр."
                : "Локальная проверка."}{" "}
            Код этой страницы запускается в браузере; не используйте здесь
            конфиденциальные данные. Внешние запросы здесь не работают. В
            подготовленной версии alert показывается внутри страницы, а confirm
            отвечает «да»; prompt возвращает значение по умолчанию.
          </p>
          {linkNote}
          {error && (
            <p className="preview-error">
              {grant
                ? "Доступ к просмотру мог истечь. Обновите страницу, чтобы проверить ссылку заново."
                : error}
              {grant && (
                <>
                  {" "}
                  <Button
                    type="button"
                    variant="quiet"
                    onClick={() => location.reload()}
                  >
                    Обновить доступ
                  </Button>
                </>
              )}
            </p>
          )}
          {grant && !error && (
            <Button
              type="button"
              variant="quiet"
              onClick={() => location.reload()}
            >
              Обновить доступ
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={launch}
            busy={busy}
          >
            {busy
              ? "Запускаем интерактивную версию…"
              : "Запустить интерактивную версию"}
          </Button>
        </div>
      )}
    </>
  );
}
