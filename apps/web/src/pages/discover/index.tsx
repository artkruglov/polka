import { useEditorialList } from "../../entities/editorial/useEditorialList.ts";
import { Button } from "../../shared/ui/controls.tsx";
import React, { useEffect, useState } from "react";
import type { EditorialPublicResponse } from "../../../../../packages/editorial.ts";
import { EditorialCatalog } from "../../widgets/editorial-catalog/index.tsx";
import {
  fetchEditorialItem,
  parseEditorialSlug,
  safeEditorialRecipientUrl,
} from "../../entities/editorial/api.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useDocumentTitle } from "../../shared/lib/document-title.ts";

function Detail({
  slug,
  retry,
  onRetry,
}: {
  slug: string;
  retry: number;
  onRetry: () => void;
}) {
  const account = useAccount();
  const [item, setItem] = useState<EditorialPublicResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    setError(null);
    fetchEditorialItem(slug, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setItem(next);
        setState(next ? "ready" : "missing");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setState("error");
        setError(
          reason instanceof Error
            ? reason.message
            : "Не удалось загрузить материал.",
        );
      });
    return () => controller.abort();
  }, [retry, slug]);
  useDocumentTitle(item?.title ?? "Лента");
  const url = item ? safeEditorialRecipientUrl(item.recipientUrl) : null;
  return (
    <AppShell current="discover" account={account}>
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
          <div
            className="editorial-catalog-state editorial-catalog-error"
            role="alert"
          >
            <p>{error}</p>
            <Button type="button" onClick={onRetry}>
              Повторить
            </Button>
          </div>
        )}
        {state === "ready" && item && (
          <article className="editorial-catalog-detail-card">
            <p>
              <a href="/discover" className="editorial-catalog-back">
                <ArrowLeft aria-hidden="true" /> Лента
              </a>
            </p>
            <span className="editorial-catalog-eyebrow">
              {item.topic} · {item.license}
            </span>
            <h1>{item.title}</h1>
            <p>{item.task}</p>
            <p>
              <strong>Что попробовать:</strong> {item.action}
            </p>
            <p className="editorial-catalog-detail-byline">
              Автор: {item.author}
            </p>
            {url ? (
              <a className="editorial-catalog-open" href={url}>
                Открыть материал <ArrowUpRight aria-hidden="true" />
              </a>
            ) : (
              <p className="editorial-catalog-error" role="alert">
                Ссылка на материал недоступна.
              </p>
            )}
          </article>
        )}
      </main>
    </AppShell>
  );
}

export function EditorialPage() {
  const account = useAccount();
  const [retry, setRetry] = useState(0);
  const slug = parseEditorialSlug(location.pathname);
  useDocumentTitle(slug ? undefined : "Лента");
  if (slug)
    return (
      <Detail
        slug={slug}
        retry={retry}
        onRetry={() => setRetry((value) => value + 1)}
      />
    );
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
  return (
    <CatalogRoute
      account={account}
      retry={retry}
      onRetry={() => setRetry((value) => value + 1)}
    />
  );
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
