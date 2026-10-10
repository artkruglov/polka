/**
 * A UUID in its usual text form, any version, either case: PostgreSQL reads
 * both cases, and people paste ids from wherever they found them. Callers
 * that compare ids as strings (the erasure ledger) or know the version (an
 * invitation link carries a randomUUID) keep their own stricter checks.
 */
export const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, "i");
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);
