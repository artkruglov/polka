/* POST /api/v1/publish (docs/PUBLISH_API.md) with the extension's token. */
import { accessToken } from "./auth.ts";
import type { PublishBody } from "./shared/payload.ts";

export type Published = {
  artifactId: string;
  state: "shared" | "saved";
  url: string | null;
  shelfUrl: string;
  expiresAt: string | null;
  linkUnavailableReason?: string;
  moderationMessage?: string;
  expiresNote?: string;
  interactiveUnavailableReason?: string;
};

export class PublishError extends Error {
  constructor(
    public code: "not_connected" | "publish_failed",
    message: string,
  ) {
    super(message);
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One publish. Network errors, 429 and 5xx are retried with the same
 * idempotency key (the server returns the same work, not a second one); a 401
 * refreshes the token once.
 */
export async function publish(origin: string, body: PublishBody): Promise<Published> {
  let token = await accessToken(origin);
  if (!token)
    throw new PublishError("not_connected", "Расширение не подключено к Полке.");
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await wait(attempt * 2000);
    let response: Response;
    try {
      response = await fetch(`${origin}/api/v1/publish`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      continue;
    }
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      token = await accessToken(origin, true);
      if (!token)
        throw new PublishError("not_connected", "Подключение к Полке закончилось. Подключите расширение снова.");
      attempt--;
      continue;
    }
    if (response.status === 429 || response.status >= 500) continue;
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return answer as unknown as Published;
    if (response.status === 401)
      throw new PublishError("not_connected", "Подключение к Полке закончилось. Подключите расширение снова.");
    if (response.status === 422 && answer.code === "unsupported")
      throw new PublishError(
        "publish_failed",
        "На этой Полке выключен интерактивный просмотр, а артефакт — React-компонент. Попросите Claude сделать из него одну HTML-страницу и сохраните её.",
      );
    throw new PublishError(
      "publish_failed",
      typeof answer.message === "string" ? answer.message : `Полка ответила ${response.status}.`,
    );
  }
  throw new PublishError("publish_failed", "Полка не отвечает. Попробуйте ещё раз чуть позже.");
}

/** One line for the user about a private save or a pending link. */
export function noteFor(published: Published): string | null {
  return (
    published.moderationMessage ??
    (published.url ? null : published.linkUnavailableReason ?? "Работа сохранена приватно, без ссылки.") ??
    published.expiresNote ??
    published.interactiveUnavailableReason ??
    null
  );
}
