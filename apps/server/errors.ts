import type { ErrorCode } from "../../packages/contracts/index.ts";
export class Problem extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    /** Extra fields of the JSON answer (a patch edit names its failing edit). */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
  /** Seconds until a limit resets: sent as Retry-After with a 429. */
  retryAfter?: number;
  /** This problem with a Retry-After (rounded up, at least 1 s). */
  retryIn(seconds: number) {
    this.retryAfter = Math.max(1, Math.ceil(seconds));
    return this;
  }
}
export const missing = () =>
  new Problem(
    404,
    "not_found",
    "Материал недоступен. Ссылка могла измениться или доступ был закрыт.",
  );
