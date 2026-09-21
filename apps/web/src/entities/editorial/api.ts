import {
  editorialPublicResponseSchema,
  type EditorialPublicResponse,
} from "../../../../../packages/editorial.ts";
import { z } from "zod";

const editorialListSchema = z.object({ items: z.array(editorialPublicResponseSchema).max(20) }).strict();

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);

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

export async function fetchEditorial(signal?: AbortSignal): Promise<EditorialPublicResponse[]> {
  const response = await fetch("/api/editorial", { signal });
  if (!response.ok) throw new Error("Не удалось загрузить редакционные материалы.");
  try {
    const payload = editorialListSchema.parse(await readJson(response));
    return payload.items;
  } catch {
    throw new Error("Не удалось прочитать каталог. Попробуйте ещё раз.");
  }
}

export async function fetchEditorialItem(
  slug: string,
  signal?: AbortSignal,
): Promise<EditorialPublicResponse | null> {
  const response = await fetch(`/api/editorial/${encodeURIComponent(slug)}`, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Не удалось загрузить материал.");
  try {
    return editorialPublicResponseSchema.parse(await readJson(response));
  } catch {
    throw new Error("Не удалось прочитать материал. Попробуйте ещё раз.");
  }
}
