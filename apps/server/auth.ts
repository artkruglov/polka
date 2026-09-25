import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import { db, transaction } from "./db.ts";
import { sha256 } from "./storage.ts";
import { Problem, missing } from "./errors.ts";
import { memberShelf, type ShelfRole } from "./shelves.ts";
import { uuid } from "../../packages/contracts/index.ts";
import { markActive, trackSignup } from "./analytics.ts";
const derive = promisify(scrypt);
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
export async function createAccount(name: string, password: string) {
  if (
    !/^[a-z0-9._-]{3,40}$/.test(name) ||
    password.length < 12 ||
    password.length > 200
  )
    throw new Error(
      "Use a 3–40 character login and a 12–200 character password",
    );
  const hash = await passwordHash(password);
  return transaction(async (c) => {
    const id = randomUUID();
    await c.query(
      // An account the operator creates is trusted from the start.
      "INSERT INTO accounts(id,name,password_hash,trusted_at) VALUES($1,$2,$3,now())",
      [id, name, hash],
    );
    const tenant = randomUUID();
    await c.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
      tenant,
      id,
    ]);
    trackSignup(c, id, "password");
    return { id, name, tenant };
  });
}
const RETRY_AFTER = {
  "10 minutes": "через 10 минут",
  "1 hour": "через час",
  "24 hours": "через сутки",
} as const;
// Fixed window per hashed key (10 minutes unless stated); shared by login and anonymous actions.
export async function limitAttempts(
  key: string,
  max: number,
  window: keyof typeof RETRY_AFTER = "10 minutes",
) {
  const {
    rows: [limit],
  } = await db.query(
    `INSERT INTO login_limits VALUES($1,1,now()+$2::interval) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limits.reset_at<now() THEN 1 ELSE login_limits.attempts+1 END, reset_at=CASE WHEN login_limits.reset_at<now() THEN now()+$2::interval ELSE login_limits.reset_at END RETURNING attempts, extract(epoch FROM reset_at-now())::float8 AS retry_after`,
    [sha256(key), window],
  );
  if (limit.attempts > max)
    throw new Problem(
      429,
      "quota",
      `Слишком много попыток. Попробуйте ${RETRY_AFTER[window]}.`,
    ).retryIn(limit.retry_after);
}
export async function signIn(name: string, password: string, ip: string) {
  await limitAttempts(`name:${name}`, 12);
  await limitAttempts(`ip:${ip}`, 100);
  const {
    rows: [candidate],
  } = await db.query("SELECT * FROM accounts WHERE name=$1", [name]);
  const [salt, hex] = (
    candidate?.password_hash ??
    "00000000000000000000000000000000:" + "00".repeat(64)
  ).split(":");
  const actual = (await derive(password, salt, 64)) as Buffer;
  if (!timingSafeEqual(actual, Buffer.from(hex, "hex")) || !candidate)
    throw new Problem(
      401,
      "unauthorized",
      "Не удалось войти. Проверьте логин и пароль.",
    );
  const token = randomBytes(32).toString("base64url");
  await transaction(async (c) => {
    const tenant = (
      await c.query("SELECT * FROM tenants WHERE owner_id=$1 FOR UPDATE", [
        candidate.id,
      ])
    ).rows[0];
    const account = (
      await c.query(
        `SELECT * FROM accounts WHERE id=$1 AND name=$2
           AND NOT disabled AND deletion_requested_at IS NULL FOR UPDATE`,
        [candidate.id, name],
      )
    ).rows[0];
    if (
      !tenant ||
      !account ||
      account.password_hash !== candidate.password_hash
    )
      throw new Problem(
        401,
        "unauthorized",
        "Не удалось войти. Проверьте логин и пароль.",
      );
    await c.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')",
      [sha256(token), account.id],
    );
  });
  return token;
}
/**
 * The signed-in account and the shelf a request works on. By default its own
 * (personal) shelf. A route that works on works — the shelf, folders, saving,
 * search — passes { shelf: true }: then the header X-Polka-Shelf may name a
 * department shelf the account is an active member of (docs/specs/
 * TEAM_SHELVES.md), and `role` is its role there. Any other shelf is «not
 * found». Account-level routes (agents, sign-in methods, deletion) never
 * follow the header.
 */
export async function identity(
  req: FastifyRequest,
  options: { shelf?: boolean } = {},
) {
  const {
    rows: [actor],
  } = await db.query(
    `SELECT a.id,COALESCE(a.display_name,a.name) AS name,t.id AS tenant,a.created_at AS "createdAt",(a.provisional_at IS NOT NULL AND a.claimed_at IS NULL) AS provisional,s.assurance<>'full' AS weak FROM sessions s JOIN accounts a ON a.id=s.account_id JOIN tenants t ON t.owner_id=a.id WHERE s.hash=$1 AND s.expires_at>now() AND NOT a.disabled AND a.deletion_requested_at IS NULL`,
    [sha256(req.cookies.polka_session ?? "")],
  );
  if (!actor)
    throw new Problem(
      401,
      "unauthorized",
      "Войдите, чтобы открыть свою полку.",
    );
  // Returning activity for retention: one row per account and day.
  markActive(actor.id);
  actor.role = "owner";
  const requested = options.shelf ? req.headers["x-polka-shelf"] : undefined;
  if (typeof requested === "string" && requested !== actor.tenant) {
    const shelf = uuid.safeParse(requested).success
      ? await memberShelf(db, actor.id, requested)
      : null;
    if (!shelf) throw missing();
    actor.tenant = shelf.id;
    actor.role = shelf.role;
  }
  return actor as {
    id: string;
    name: string;
    tenant: string;
    /** The account's role on that shelf: 'owner' on its own. */
    role: ShelfRole;
    /** null for accounts older than the abuse-protection migration (029). */
    createdAt: Date | null;
    /** A provisional shelf nobody has claimed yet (provisional.ts). */
    provisional: boolean;
    /**
     * The session came from an agent's sign-in link (agent-sign-in-links.ts):
     * it browses, but cannot claim, merge, link or unlink sign-in methods,
     * manage agents or delete the account.
     */
    weak: boolean;
  };
}

/** Refuses what a session opened by an agent's link may not do. */
export function assertStrongSession(actor: { weak?: boolean }) {
  if (actor.weak)
    throw new Problem(
      403,
      "forbidden",
      "Вы вошли по ссылке от агента. Для этого действия войдите через Яндекс ID, VK ID или по почте.",
      { reason: "agent_link_session" },
    );
}
