import { Button } from "../../shared/ui/controls.tsx";
import React, { useState } from "react";
import { EditorialArtwork } from "../../entities/editorial/Artwork.tsx";
import { editorialCover } from "../../entities/editorial/covers.ts";
import type { EditorialPublicResponse } from "../../../../../packages/editorial.ts";

import { safeEditorialRecipientUrl } from "../../entities/editorial/api.ts";

export type EditorialCatalogProps = {
  items: readonly EditorialPublicResponse[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  headingLevel?: 1 | 2;
};

export function EditorialCatalog({
  items,
  loading = false,
  error = null,
  onRetry,
  headingLevel = 2,
}: EditorialCatalogProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const [topic, setTopic] = useState<string | null>(null);
  const topics = [...new Set(items.map((item) => item.topic))];
  const activeTopic = topic && topics.includes(topic) ? topic : null;
  const visibleItems = activeTopic
    ? items.filter((item) => item.topic === activeTopic)
    : items;
  return (
    <section
      className="editorial-catalog"
      aria-labelledby="editorial-catalog-title"
    >
      <div className="editorial-catalog-heading">
        <div>
          <Heading id="editorial-catalog-title">Интересное</Heading>
          <p>Отчёты, идеи и инструменты, которые хочется открыть.</p>
        </div>
      </div>

      {loading && (
        <div
          className="editorial-catalog-state"
          role="status"
          aria-live="polite"
        >
          Загружаем материалы…
        </div>
      )}

      {!loading && error && (
        <div
          className="editorial-catalog-state editorial-catalog-error"
          role="alert"
        >
          <p>{error}</p>
          {onRetry && (
            <Button type="button" onClick={onRetry}>
              Повторить
            </Button>
          )}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="editorial-catalog-state">
          Здесь пока нет опубликованных материалов.
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="editorial-topics" aria-label="Темы материалов">
          {[null, ...topics].map((value) => (
            <Button
              key={value ?? "all"}
              type="button"
              aria-pressed={activeTopic === value}
              onClick={() => setTopic(value)}
            >
              {value ?? "Всё"}
            </Button>
          ))}
          <span role="status">Материалов: {visibleItems.length}</span>
        </div>
      )}
      {!loading && !error && items.length > 0 && (
        <div className="editorial-catalog-grid">
          {visibleItems.map((item) => (
            <article className="editorial-catalog-card" key={item.slug}>
              {(() => {
                const recipientUrl = safeEditorialRecipientUrl(
                  item.recipientUrl,
                );
                return (
                  <>
                    {editorialCover(item.slug, item.title) && recipientUrl && (
                      <a
                        className="editorial-cover"
                        href={recipientUrl}
                        aria-label={`Открыть ${item.title}`}
                      >
                        <EditorialArtwork slug={item.slug} />
                      </a>
                    )}
                    <h3>
                      {recipientUrl ? (
                        <a href={recipientUrl}>{item.title}</a>
                      ) : (
                        item.title
                      )}
                    </h3>

                    <div className="editorial-catalog-card-footer">
                      <span title={`${item.license} · ${item.action}`}>
                        {item.topic} · {item.author}
                      </span>
                      {recipientUrl ? (
                        <a href={recipientUrl}>
                          Открыть <span aria-hidden="true">↗</span>
                        </a>
                      ) : (
                        <span>Ссылка недоступна</span>
                      )}
                    </div>
                  </>
                );
              })()}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
