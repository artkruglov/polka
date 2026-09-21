import { useEffect, useState } from "react";
import type { EditorialPublicResponse } from "../../../../../packages/editorial.ts";
import { fetchEditorial } from "./api.ts";
export function useEditorialList(retry: number) {
  const [items, setItems] = useState<EditorialPublicResponse[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    setError(null);
    fetchEditorial(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setItems(next);
        setState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setState("error");
        setError(
          reason instanceof Error
            ? reason.message
            : "Не удалось загрузить материалы.",
        );
      });
    return () => controller.abort();
  }, [retry]);
  return { items, state, error };
}
