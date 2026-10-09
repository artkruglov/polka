import { useEffect, useState } from "react";
import type { Folder } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";

export function useFolders(accountId?: string) {
  const [result, setResult] = useState<{
    accountId?: string;
    attempt?: number;
    items: Folder[];
    error: string;
    loading: boolean;
  }>({ items: [], error: "", loading: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!accountId) return;
    let current = true;
    client
      .folders()
      .then((items) => {
        if (current) setResult({ accountId, attempt, items, error: "", loading: false });
      })
      .catch(() => {
        if (current)
          setResult({
            accountId,
            attempt,
            items: [],
            error: "Не удалось загрузить папки. Можно сохранить без папки или повторить загрузку.",
            loading: false,
          });
      });
    return () => {
      current = false;
    };
  }, [accountId, attempt]);
  // Another account or a retry reads as loading until its own answer arrives.
  const state =
    result.accountId === accountId && result.attempt === attempt
      ? result
      : { items: [], error: "", loading: !!accountId };
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
