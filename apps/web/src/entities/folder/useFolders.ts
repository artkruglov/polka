import { useEffect, useState } from "react";
import type { Folder } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";

export function useFolders(accountId?: string) {
  const [result, setResult] = useState<{
    accountId?: string;
    items: Folder[];
    error: string;
    loading: boolean;
  }>({ items: [], error: "", loading: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!accountId) return;
    let current = true;
    setResult({ accountId, items: [], error: "", loading: true });
    client
      .folders()
      .then((items) => {
        if (current) setResult({ accountId, items, error: "", loading: false });
      })
      .catch(() => {
        if (current)
          setResult({
            accountId,
            items: [],
            error:
              "Не удалось загрузить папки. Можно сохранить без папки или повторить загрузку.",
            loading: false,
          });
      });
    return () => {
      current = false;
    };
  }, [accountId, attempt]);
  const state =
    result.accountId === accountId
      ? result
      : { items: [], error: "", loading: !!accountId };
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
