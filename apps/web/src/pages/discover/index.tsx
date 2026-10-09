import "./styles.css";
import "../../features/recipient-convert/styles.css";
import { useEditorialList } from "../../entities/editorial/useEditorialList.ts";
import { Badge, Button } from "../../shared/ui/controls.tsx";
import React, { useEffect, useRef, useState } from "react";
import type { EditorialPublicResponse } from "../../../../../packages/editorial.ts";
import type { Resolved, Viewer } from "../../../../../packages/contracts/index.ts";
import { EditorialCatalog } from "../../widgets/editorial-catalog/index.tsx";
import { fetchEditorialItem, parseEditorialSlug, safeEditorialRecipientUrl } from "../../entities/editorial/api.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { Preview } from "../../widgets/artifact-preview/index.ts";
import { ArrowLeft, ArrowUpRight, Maximize2 } from "lucide-react";
import { useDocumentTitle } from "../../shared/lib/document-title.ts";
import { ApiError, client } from "../../shared/api/client.ts";
import { useCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import { isFreshAccount } from "../../entities/recipient-convert/fresh-account.ts";
import { takeConvertReturn } from "../../entities/recipient-convert/return.ts";
import { ProviderButtons } from "../../features/provider-sign-in/index.tsx";
import {
  ConvertBar,
  ConvertCard,
  SignedInFromShare,
  leaveForProvider,
  useRecipientConvert,
} from "../../features/recipient-convert/index.tsx";

/** The share token behind a material's recipient link; the frame opens it like /s does. */
export function editorialShareToken(recipientUrl: string | null): string | null {
  if (!recipientUrl) return null;
  try {
    const hash = new URL(recipientUrl).hash;
    return hash.length > 1 ? hash.slice(1) : null;
  } catch {
    return null;
  }
}

type WorkState =
  { status: "loading" } | { status: "ready"; viewer: Viewer } | { status: "unavailable"; message: string };

/**
 * A feed material, document first: a thin header («Лента», the title, the
 * section), then the same isolated frame a recipient of the editorial link
 * sees, filling the rest of the viewport. A guest gets the same way in as
 * on a shared work (features/recipient-convert, page "feed").
 */
function Detail({ slug, retry, onRetry }: { slug: string; retry: number; onRetry: () => void }) {
  const account = useAccount();
  const [item, setItem] = useState<EditorialPublicResponse | null>(null);
  // The outcome of one attempt: another slug or a retry reads as «loading» until its own answer.
  const [outcome, setOutcome] = useState<{
    slug: string;
    retry: number;
    state: "ready" | "missing" | "error";
    error: string | null;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchEditorialItem(slug, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setItem(next);
        setOutcome({ slug, retry, state: next ? "ready" : "missing", error: null });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setOutcome({
          slug,
          retry,
          state: "error",
          error: reason instanceof Error ? reason.message : "Не удалось загрузить материал.",
        });
      });
    return () => controller.abort();
  }, [retry, slug]);
  const { state, error } =
    outcome?.slug === slug && outcome.retry === retry ? outcome : { state: "loading" as const, error: null };
  useDocumentTitle(item?.title ?? "Лента");
  const url = item ? safeEditorialRecipientUrl(item.recipientUrl) : null;
  const token = editorialShareToken(url);

  // The work itself, through the link's token, as the recipient page opens it.
  const [resolvedWork, setResolvedWork] = useState<{ token: string; retry: number; work: WorkState } | null>(null);
  useEffect(() => {
    if (!token) return;
    let live = true;
    const settle = (work: WorkState) => setResolvedWork({ token, retry, work });
    client
      .resolve(token)
      .then((resolved: Resolved) => {
        if (!live) return;
        if ("review" in resolved || "blocked" in resolved)
          settle({ status: "unavailable", message: "Материал сейчас недоступен." });
        else settle({ status: "ready", viewer: resolved });
      })
      .catch((e: unknown) => {
        if (!live) return;
        const unreachable = !(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500;
        settle({
          status: "unavailable",
          message: unreachable
            ? "Полка сейчас не отвечает. Попробуйте ещё раз."
            : "Материал по этой ссылке недоступен.",
        });
      });
    return () => {
      live = false;
    };
  }, [token, retry]);
  // Another link or a retry reads as «loading» until its own answer.
  const work: WorkState =
    resolvedWork && resolvedWork.token === token && resolvedWork.retry === retry
      ? resolvedWork.work
      : { status: "loading" };

  const path = `/discover/${slug}`;
  const guest = account === null;
  const shown = work.status === "ready" ? work.viewer : null;
  // Destructured: the stage ref is only handed to the element, never read in render.
  const { stageRef, card, press, close } = useRecipientConvert({ enabled: guest && shown !== null, page: "feed" });
  const capabilities = useCapabilities();
  const yandex =
    capabilities.status === "ready" ? capabilities.capabilities.signInProviders.filter((p) => p.id === "yandex") : [];
  const [welcome, setWelcome] = useState(() => takeConvertReturn(path));

  // The card floats above the bar: its height goes into a CSS variable.
  const frame = useRef<HTMLDivElement>(null);
  const footerBox = useRef<HTMLDivElement>(null);
  const withBar = guest && shown !== null;
  useEffect(() => {
    const node = footerBox.current;
    const host = frame.current;
    if (!host) return;
    if (!node || typeof ResizeObserver === "undefined") {
      host.style.removeProperty("--convert-bar-height");
      return;
    }
    const measure = () => host.style.setProperty("--convert-bar-height", `${node.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [withBar]);

  return (
    <AppShell current="discover" account={account} className="feed-reader">
      {state !== "ready" || !item ? (
        <main className="editorial-catalog editorial-catalog-detail">
          {state === "loading" && (
            <div className="editorial-catalog-state" role="status">
              Загружаем материал…
            </div>
          )}
          {state === "missing" && (
            <div className="editorial-catalog-state" role="alert">
              Материал не найден. <a href="/discover">Вернуться к подборке</a>
            </div>
          )}
          {state === "error" && (
            <div className="editorial-catalog-state editorial-catalog-error" role="alert">
              <p>{error}</p>
              <Button type="button" onClick={onRetry}>
                Повторить
              </Button>
            </div>
          )}
        </main>
      ) : (
        <div ref={frame} className="feed-material">
          <header className="feed-topbar">
            <a href="/discover" className="feed-back">
              <ArrowLeft aria-hidden="true" /> <span>Лента</span>
            </a>
            <h1 className="feed-title" title={item.title}>
              {item.title}
            </h1>
            <Badge tone="accent" className="feed-topic">
              {item.topic}
            </Badge>
            <div className="feed-actions">
              <Button
                variant="secondary"
                className="feed-fullscreen"
                aria-label="Открыть на весь экран"
                title="Открыть на весь экран"
                disabled={shown === null}
                onClick={() => void stageRef.current?.requestFullscreen?.()}
              >
                <Maximize2 aria-hidden="true" /> <span>Открыть на весь экран</span>
              </Button>
            </div>
          </header>
          <p className="feed-task" title={`${item.task}. Что попробовать: ${item.action}`}>
            {item.task}. <span>Что попробовать: {item.action}</span>
          </p>
          {welcome && account && (
            <SignedInFromShare
              created={isFreshAccount(account)}
              origin={location.origin}
              page="feed"
              onClose={() => setWelcome(false)}
            />
          )}
          <main ref={stageRef} className="feed-stage" aria-label={item.title}>
            {!token ? (
              <p className="feed-state" role="alert">
                Ссылка на материал недоступна.
              </p>
            ) : work.status === "loading" ? (
              <p className="feed-state" role="status">
                Открываем материал…
              </p>
            ) : work.status === "unavailable" ? (
              <div className="feed-state" role="alert">
                <p>{work.message}</p>
                <Button type="button" onClick={onRetry}>
                  Повторить
                </Button>
              </div>
            ) : (
              <Preview revision={work.viewer.revision} grant={work.viewer.grant} />
            )}
          </main>
          <footer className="feed-footer">
            <span>
              Лицензия материала: {item.license} · {item.author}
            </span>
            {url && (
              <a href={url}>
                Открыть по ссылке <ArrowUpRight aria-hidden="true" />
              </a>
            )}
          </footer>
          {withBar && (
            <div ref={footerBox} className="feed-convert">
              <ConvertBar onTry={(opener) => press("try", opener)} onRemix={(opener) => press("remix", opener)} />
            </div>
          )}
          {withBar && card && shown && (
            <ConvertCard
              variant={card.variant}
              page="feed"
              origin={location.origin}
              revision={shown.revision}
              back={{ path }}
              signIn={
                yandex.length ? (
                  <ProviderButtons
                    providers={yandex}
                    next={path}
                    onLeave={() => leaveForProvider({ path }, card.variant, "feed")}
                  />
                ) : undefined
              }
              onClose={close}
            />
          )}
        </div>
      )}
    </AppShell>
  );
}

export function EditorialPage() {
  const account = useAccount();
  const [retry, setRetry] = useState(0);
  const slug = parseEditorialSlug(location.pathname);
  useDocumentTitle(slug ? undefined : "Лента");
  if (slug) return <Detail slug={slug} retry={retry} onRetry={() => setRetry((value) => value + 1)} />;
  if (location.pathname.startsWith("/discover/")) {
    return (
      <AppShell current="discover" account={account}>
        <main className="editorial-catalog">
          <div className="editorial-catalog-state" role="alert">
            Материал не найден. <a href="/discover">Вернуться к подборке</a>
          </div>
        </main>
      </AppShell>
    );
  }
  return <CatalogRoute account={account} retry={retry} onRetry={() => setRetry((value) => value + 1)} />;
}

function CatalogRoute({
  account,
  retry,
  onRetry,
}: {
  account: ReturnType<typeof useAccount>;
  retry: number;
  onRetry: () => void;
}) {
  const list = useEditorialList(retry);
  return (
    <AppShell current="discover" account={account}>
      <main>
        <EditorialCatalog
          headingLevel={1}
          items={list.items}
          loading={list.state === "loading"}
          error={list.state === "error" ? list.error : null}
          onRetry={onRetry}
        />
      </main>
    </AppShell>
  );
}
