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
}
export const missing = () =>
  new Problem(
    404,
    "not_found",
    "Материал недоступен. Ссылка могла измениться или доступ был закрыт.",
  );
