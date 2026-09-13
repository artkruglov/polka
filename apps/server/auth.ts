import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import { db, transaction } from "./db.ts";
import { sha256 } from "./storage.ts";
import { Problem } from "./errors.ts";
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
      "INSERT INTO accounts(id,name,password_hash) VALUES($1,$2,$3)",
      [id, name, hash],
    );
    const tenant = randomUUID();
    await c.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
      tenant,
      id,
    ]);
    return { id, name, tenant };
  });
}
export async function signIn(name: string, password: string, ip: string) {
  for (const [key, max] of [
    [sha256(`name:${name}`), 12],
    [sha256(`ip:${ip}`), 100],
  ] as const) {
    const {
      rows: [limit],
    } = await db.query(
      `INSERT INTO login_limits VALUES($1,1,now()+interval '10 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limits.reset_at<now() THEN 1 ELSE login_limits.attempts+1 END, reset_at=CASE WHEN login_limits.reset_at<now() THEN now()+interval '10 minutes' ELSE login_limits.reset_at END RETURNING attempts`,
      [key],
    );
    if (limit.attempts > max)
      throw new Problem(
        429,
        "quota",
        "Слишком много попыток. Попробуйте через 10 минут.",
      );
  }
  const {
    rows: [account],
  } = await db.query("SELECT * FROM accounts WHERE name=$1", [name]);
  const [salt, hex] = (
    account?.password_hash ??
    "00000000000000000000000000000000:" + "00".repeat(64)
  ).split(":");
  const actual = (await derive(password, salt, 64)) as Buffer;
  if (
    !timingSafeEqual(actual, Buffer.from(hex, "hex")) ||
    !account ||
    account.disabled
  )
    throw new Problem(
      401,
      "unauthorized",
      "Не удалось войти. Проверьте логин и пароль.",
    );
  const token = randomBytes(32).toString("base64url");
  await db.query("INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')", [
    sha256(token),
    account.id,
  ]);
  return token;
}
export async function identity(req: FastifyRequest) {
  const {
    rows: [actor],
  } = await db.query(
    `SELECT a.id,a.name,t.id AS tenant FROM sessions s JOIN accounts a ON a.id=s.account_id JOIN tenants t ON t.owner_id=a.id WHERE s.hash=$1 AND s.expires_at>now() AND NOT a.disabled`,
    [sha256(req.cookies.polka_session ?? "")],
  );
  if (!actor)
    throw new Problem(
      401,
      "unauthorized",
      "Войдите, чтобы открыть свою полку.",
    );
  return actor as { id: string; name: string; tenant: string };
}
