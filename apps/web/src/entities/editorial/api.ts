import { editorialPublicResponseSchema, type EditorialPublicResponse } from "../../../../../packages/editorial.ts";
import { z } from "zod";
import { ApiError, send } from "../../shared/api/client.ts";

const editorialListSchema = z.object({ items: z.array(editorialPublicResponseSchema).max(20) }).strict();

const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80);

export function parseEditorialSlug(pathname: string): string | null {
  if (!pathname.startsWith("/discover/")) return null;
  try {
    const slug = decodeURIComponent(pathname.slice("/discover/".length));
    return slugSchema.safeParse(slug).success ? slug : null;
  } catch {
    return null;
  }
}

export function safeEditorialRecipientUrl(
  value: string,
  origin = typeof location === "undefined" ? undefined : location.origin,
): string | null {
  if (!origin) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return null;
    if (url.pathname !== "/s" || url.search !== "" || !url.hash || url.hash.length < 2) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Сервер вернул некорректный ответ.");
  }
}

// Through the app's one request path (shared/api/client.ts): a network
// failure or an error answer reads in Russian, never «Failed to fetch».
export async function fetchEditorial(signal?: AbortSignal): Promise<EditorialPublicResponse[]> {
  const response = await send("/api/editorial", { signal });
  try {
    const payload = editorialListSchema.parse(await readJson(response));
    return payload.items;
  } catch {
    throw new Error("Не удалось прочитать каталог. Попробуйте ещё раз.");
  }
}

export async function fetchEditorialItem(slug: string, signal?: AbortSignal): Promise<EditorialPublicResponse | null> {
  let response: Response;
  try {
    response = await send(`/api/editorial/${encodeURIComponent(slug)}`, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  try {
    return editorialPublicResponseSchema.parse(await readJson(response));
  } catch {
    throw new Error("Не удалось прочитать материал. Попробуйте ещё раз.");
  }
}
