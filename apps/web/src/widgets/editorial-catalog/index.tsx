import { Button, Chip, LinkButton } from "../../shared/ui/controls.tsx";
import { Wave } from "../../shared/ui/Wave.tsx";
import { ArrowUpRight, Bot, FileUp } from "lucide-react";
import React, { useState } from "react";
import { EditorialArtwork } from "../../entities/editorial/Artwork.tsx";
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
          <Heading id="editorial-catalog-title">Лента</Heading>
          <p>Исследования, разборы и инструменты, сделанные с Claude.</p>
        </div>
      </div>

      {loading && (
        <div className="editorial-catalog-grid" role="status" aria-live="polite" aria-label="Загружаем материалы…">
          {[0, 1, 2].map((i) => (
            <div key={i} className="editorial-catalog-card">
              <div className="editorial-cover placeholder" />
            </div>
          ))}
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
        <div className="editorial-catalog-empty">
          <Wave compact className="editorial-catalog-empty-wave" />
          <div className="editorial-catalog-empty-body">
            <h3>Пока здесь пусто</h3>
            <p>
              В «Ленте» появляются материалы, которые авторы опубликовали
              после проверки. Ваши работы сюда не попадают сами: по умолчанию
              их видите только вы.
            </p>
            <div className="editorial-catalog-empty-actions">
              <LinkButton variant="primary" href="/bring#file">
                <FileUp /> Сохранить свою работу
              </LinkButton>
              <LinkButton href="/settings/agents">
                <Bot /> Подключить агента
              </LinkButton>
            </div>
          </div>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="editorial-topics" role="group" aria-label="Темы материалов">
          <div className="ui-chips">
            {[null, ...topics].map((value) => (
              <Chip
                key={value ?? "all"}
                pressed={activeTopic === value}
                onClick={() => setTopic(value)}
              >
                {value ?? "Всё"}
              </Chip>
            ))}
          </div>
          <span role="status">Материалов: {visibleItems.length}</span>
        </div>
      )}
      {!loading && !error && items.length > 0 && (
        <div className="editorial-catalog-grid">
          {visibleItems.map((item) => {
            const recipientUrl = safeEditorialRecipientUrl(item.recipientUrl);
            return (
              <article className="editorial-catalog-card" key={item.slug}>
                {recipientUrl ? (
                  <a
                    className="editorial-cover"
                    href={recipientUrl}
                    aria-label={`Открыть ${item.title}`}
                    tabIndex={-1}
                  >
                    <EditorialArtwork item={item} />
                  </a>
                ) : (
                  <div className="editorial-cover">
                    <EditorialArtwork item={item} />
                  </div>
                )}
                <div className="editorial-catalog-card-body">
                  <h3>
                    {recipientUrl ? (
                      <a href={recipientUrl}>{item.title}</a>
                    ) : (
                      item.title
                    )}
                  </h3>
                  <span className="editorial-catalog-card-meta" title={`${item.license} · ${item.action}`}>
                    {item.topic} · {item.author}
                  </span>
                </div>
                <div className="editorial-catalog-card-footer">
                  {recipientUrl ? (
                    <a href={recipientUrl}>
                      Открыть <ArrowUpRight aria-hidden="true" />
                    </a>
                  ) : (
                    <span>Ссылка недоступна</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
