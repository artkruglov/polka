// The recipient page's prompt, counted anonymously (apps/server/recipient-cta.ts).
// The body is two enumerated words: never the link's token, a title or a URL.

export type RecipientCtaSurface = "bar" | "card";
export type RecipientCtaAction = "try" | "remix" | "copy_phrase" | "yandex" | "email";
export type RecipientCtaEvent =
  | { event: "view"; surface: RecipientCtaSurface }
  | { event: "click"; action: RecipientCtaAction };

export const RECIPIENT_CTA_PATH = "/api/recipient-cta";

/** The exact request body: what leaves the browser, and all of it. */
export const recipientCtaBody = (input: RecipientCtaEvent): string =>
  JSON.stringify(
    input.event === "view"
      ? { event: "view", surface: input.surface }
      : { event: "click", action: input.action },
  );

type Send = (path: string, body: string) => Promise<unknown>;

const send: Send = (path, body) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    // The click events are followed by navigation: let the request finish.
    keepalive: true,
  });

/** Fire and forget: a failed count never touches the page. */
export function trackRecipientCta(input: RecipientCtaEvent, transport: Send = send) {
  try {
    void transport(RECIPIENT_CTA_PATH, recipientCtaBody(input)).catch(() => undefined);
  } catch {
    // No fetch (tests): nothing to count.
  }
}
