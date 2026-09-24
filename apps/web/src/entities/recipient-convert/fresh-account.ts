import type { Account } from "../../../../../packages/contracts/index.ts";

/** An account this young signed up just now (the «Полка создана» note). */
export const FRESH_ACCOUNT_MS = 30 * 60 * 1000;

export const isFreshAccount = (account: Account, now = Date.now()) =>
  !!account.createdAt &&
  Number.isFinite(Date.parse(account.createdAt)) &&
  now - Date.parse(account.createdAt) < FRESH_ACCOUNT_MS;
