import { useEffect, useState } from "react";
import type { Account } from "../../../../../../packages/contracts/index.ts";
import { client } from "../../../shared/api/client.ts";

/** undefined — ещё проверяем, null — гость (или API недоступен). */
export function useAccount() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    client
      .me()
      .then((a) => live && setAccount(a))
      .catch(() => live && setAccount(null));
    return () => {
      live = false;
    };
  }, []);
  return account;
}

