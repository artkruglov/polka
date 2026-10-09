import { useEffect, useState } from "react";
import type { EditorialPublicResponse } from "../../../../../packages/editorial.ts";
import { fetchEditorial } from "./api.ts";
export function useEditorialList(retry: number) {
  const [items, setItems] = useState<EditorialPublicResponse[]>([]);
  // The outcome of one attempt: a new retry reads as «loading» until its own answer.
  const [outcome, setOutcome] = useState<{ retry: number; state: "ready" | "error"; error: string | null } | null>(
    null,
  );
  useEffect(() => {
    const controller = new AbortController();
    fetchEditorial(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setItems(next);
        setOutcome({ retry, state: "ready", error: null });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setOutcome({
          retry,
          state: "error",
          error: reason instanceof Error ? reason.message : "Не удалось загрузить материалы.",
        });
      });
    return () => controller.abort();
  }, [retry]);
  const { state, error } = outcome?.retry === retry ? outcome : { state: "loading" as const, error: null };
  return { items, state, error };
}
