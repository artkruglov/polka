import React from "react";
import { ArrowUpRight } from "lucide-react";
import {
  LINK_PROVIDERS,
  type LinkProvider,
  type LinkProviderId,
} from "../../../../../packages/contracts/link-providers.ts";
import { ServiceMark } from "../../shared/ui/ServiceMark.tsx";

/*
 * A link work («Сохранить как ссылку», docs/specs/SAVED_LINKS.md): Полка keeps
 * the address, not the content. The same card on the shelf, on the work page
 * and for a recipient: the service's badge from the provider table, the
 * title, the host and «Открыть ↗» to the original in a new tab.
 */

export const providerById = (id: LinkProviderId | null | undefined): LinkProvider | null =>
  (id && LINK_PROVIDERS.find((provider) => provider.id === id)) || null;

export const OWNER_LINK_HINT =
  "Содержимое хранится у сервиса. Чтобы сохранить копию, используйте расширение или попросите агента.";

/**
 * The recipient needs access to the original: what the owner is told before
 * sending such a link, and what the recipient reads under the button.
 */
export function recipientAccessNote(
  host: string,
  service: LinkProviderId | null,
  reader: "owner" | "recipient" = "owner",
): string {
  const provider = providerById(service);
  if (reader === "recipient")
    return service === "claude"
      ? "Артефакт Claude откроется, если автор включил доступ по ссылке."
      : `Оригинал хранится ${provider ? `в ${provider.name}` : `на ${host}`}: Полка его не копировала. Если он закрыт или удалён, открыть его не получится.`;
  if (service === "claude")
    return "Получатель откроет артефакт Claude, если автор включил доступ по ссылке (Publish / «Anyone with the link»). Иначе он увидит только карточку.";
  if (provider && ["claude", "chatgpt", "v0", "perplexity", "aistudio", "gemini"].includes(provider.id))
    return `Получатель откроет оригинал, только если у него есть доступ к нему в ${provider.name}. Иначе он увидит только карточку.`;
  return `Получатель откроет оригинал на ${host}. Если страницу закроют или удалят, он увидит только карточку.`;
}

export function LinkCover({
  title,
  host,
  service,
}: {
  title: string;
  host: string;
  service: LinkProviderId | null;
}) {
  const provider = providerById(service);
  return (
    <div className="link-cover" aria-hidden="true">
      <ServiceMark provider={provider} size="lg" />
      <strong>{title}</strong>
      <span>
        {provider ? `${provider.name} · ` : ""}
        {host}
      </span>
    </div>
  );
}

export function LinkCard({
  title,
  host,
  service,
  href,
  note,
  hint,
}: {
  title: string;
  host: string;
  service: LinkProviderId | null;
  /** The original (for a recipient), or the owner's redirect to it. */
  href: string;
  note?: string | null;
  hint?: string;
}) {
  const provider = providerById(service);
  return (
    <article className="link-card" data-service={service ?? "site"}>
      <div className="link-card-head">
        <ServiceMark provider={provider} size="lg" />
        <div>
          <span className="link-card-kind">Ссылка{provider ? ` · ${provider.name}` : ""}</span>
          <h2>{title}</h2>
          <span className="link-card-host">{host}</span>
        </div>
      </div>
      {note && <p className="link-card-note">{note}</p>}
      <a
        className="ui-button ui-button--primary link-card-open"
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        Открыть <ArrowUpRight />
      </a>
      {hint && <p className="link-card-hint">{hint}</p>}
    </article>
  );
}
