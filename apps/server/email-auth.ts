import {
  randomBytes,
  randomInt,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import nodemailer from "nodemailer";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { limitAttempts, passwordHash } from "./auth.ts";
import { sha256 } from "./storage.ts";
import { Problem } from "./errors.ts";

const fingerprint = (id: string, code: string) =>
  createHmac("sha256", config.LINK_KEY)
    .update(`email:${id}:${code}`)
    .digest("hex");

// Guessing is bounded by the code, not by a lock on the address: any limit
// counted per address can be spent by a stranger who knows it, which locked
// the owner out for a day. An eight-digit code, five tries per code and three
// codes per address per 10 minutes allow at most 2 160 guesses a day, under 1%
// over a year of continuous attack, and every code of that attack is an email
// in the owner's inbox.
const CODE_DIGITS = 8;

type LocalDeliveryClient = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{
    rowCount: number | null;
    rows: Array<Record<string, unknown>>;
  }>;
};

export async function deliverLocalEmailChallenge(
  input: { id: string; email: string; code: string },
  dependencies: {
    runTransaction?: <T>(
      operation: (client: LocalDeliveryClient) => Promise<T>,
    ) => Promise<T>;
    write?: (path: string, body: string) => Promise<void>;
  } = {},
) {
  const run =
    dependencies.runTransaction ??
    ((operation) => transaction(operation as any));
  const write =
    dependencies.write ??
    (async (path, body) => {
      await mkdir(".local/mail", { recursive: true, mode: 0o700 });
      await writeFile(path, body, { flag: "wx", mode: 0o600 });
    });
  return run(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      input.email,
    ]);
    const current = await c.query(
      `SELECT 1 FROM login_challenges challenge
       WHERE challenge.id=$1 AND challenge.email=$2
         AND challenge.consumed_at IS NULL AND challenge.expires_at>now()
         AND NOT EXISTS(
           SELECT 1 FROM accounts account WHERE account.email=$2
             AND (account.disabled OR account.deletion_requested_at IS NOT NULL)
         )`,
      [input.id, input.email],
    );
    if (!current.rowCount) return false;
    // The email advisory lock stays held until the write has actually settled,
    // so account purge cannot certify local mail as cleared while a late file
    // writer is still in flight.
    await write(
      `.local/mail/${input.id}.json`,
      JSON.stringify(
        {
          email: input.email,
          code: input.code,
          expiresInSeconds: 600,
          notice: "LOCAL TEST ONLY — not delivered",
        },
        null,
        2,
      ),
    );
    return true;
  });
}

export async function beginEmailLogin(email: string, ip: string) {
  if (config.MAIL_MODE === "disabled")
    throw new Problem(
      503,
      "invalid",
      "Вход по почте ещё не настроен на этой установке.",
    );
  if (config.MAIL_MODE === "local" && !email.endsWith(".test"))
    throw new Problem(
      400,
      "invalid",
      "Локальная проверка: используйте вымышленный адрес с доменом .test. Письмо не отправляется.",
    );
  await limitAttempts(`email-send:${email}`, 3);
  await limitAttempts(`email-send-ip:${ip}`, 20);
  const id = randomUUID(),
    code = String(randomInt(10 ** (CODE_DIGITS - 1), 10 ** CODE_DIGITS)),
    browser = randomBytes(32).toString("base64url");
  const stored = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      email,
    ]);
    const blocked = (
      await c.query(
        `SELECT 1 FROM accounts
         WHERE email=$1 AND (disabled OR deletion_requested_at IS NOT NULL)`,
        [email],
      )
    ).rowCount;
    if (blocked) return false;
    await c.query(
      `INSERT INTO login_challenges(id,email,code_hash,browser_hash,delivery,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')`,
      [id, email, fingerprint(id, code), sha256(browser), config.MAIL_MODE],
    );
    return true;
  });
  if (!stored)
    return { id, browser, delivery: config.MAIL_MODE, expiresInSeconds: 600 };
  try {
    if (config.MAIL_MODE === "local") {
      const delivered = await deliverLocalEmailChallenge({ id, email, code });
      if (!delivered)
        return {
          id,
          browser,
          delivery: config.MAIL_MODE,
          expiresInSeconds: 600,
        };
    } else {
      const transport = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        requireTLS: true,
        auth: config.SMTP_USER
          ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
          : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      });
      const result = await transport.sendMail({
        from: config.MAIL_FROM,
        to: email,
        subject: "Код для входа в Полку",
        text: `Ваш код: ${code.slice(0, 4)} ${code.slice(4)}\nОн действует 10 минут. Если вы не запрашивали вход, проигнорируйте это письмо.`,
      });
      if (!result.accepted.length) throw new Error("Mail not accepted");
    }
  } catch {
    await db.query(
      "UPDATE login_challenges SET consumed_at=now() WHERE id=$1",
      [id],
    );
    throw new Problem(
      503,
      "invalid",
      "Не удалось отправить код. Попробуйте позже.",
    );
  }
  return { id, browser, delivery: config.MAIL_MODE, expiresInSeconds: 600 };
}
export async function verifyEmailLogin(
  id: string,
  code: string,
  browser: string,
  ip: string,
) {
  if (config.MAIL_MODE === "disabled")
    throw new Problem(503, "invalid", "Вход по почте отключён.");
  await limitAttempts(`email-verify-ip:${ip}`, 40);
  const token = await transaction(async (c) => {
    const {
      rows: [challenge],
    } = await c.query(
      "SELECT *, expires_at>now() AS fresh FROM login_challenges WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (
      !challenge ||
      !challenge.fresh ||
      challenge.consumed_at ||
      challenge.attempts >= 5 ||
      challenge.delivery !== config.MAIL_MODE ||
      challenge.browser_hash !== sha256(browser)
    )
      return null;
    await c.query(
      "UPDATE login_challenges SET attempts=attempts+1 WHERE id=$1",
      [id],
    );
    if (
      !timingSafeEqual(
        Buffer.from(challenge.code_hash, "hex"),
        Buffer.from(fingerprint(id, code), "hex"),
      )
    )
      return null;
    // Serialize two independently issued challenges for the same verified identity.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      challenge.email,
    ]);
    let {
      rows: [account],
    } = await c.query("SELECT * FROM accounts WHERE email=$1", [
      challenge.email,
    ]);
    if (account) {
      const tenant = (
        await c.query("SELECT * FROM tenants WHERE owner_id=$1 FOR UPDATE", [
          account.id,
        ])
      ).rows[0];
      account = (
        await c.query(
          `SELECT * FROM accounts WHERE id=$1 AND email=$2
           AND NOT disabled AND deletion_requested_at IS NULL FOR UPDATE`,
          [account.id, challenge.email],
        )
      ).rows[0];
      if (!tenant || !account) return null;
    }
    if (!account) {
      const accountId = randomUUID();
      // Unused random password keeps legacy password login separate from email identities.
      const password = await passwordHash(randomBytes(32).toString("hex"));
      const res = await c.query(
        `INSERT INTO accounts(id,name,password_hash,email,display_name,email_verified_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6='smtp' THEN now() ELSE NULL END) RETURNING *`,
        [
          accountId,
          `email-${accountId}`,
          password,
          challenge.email,
          challenge.email.split("@")[0].slice(0, 40),
          challenge.delivery,
        ],
      );
      account = res.rows[0];
      await c.query("INSERT INTO tenants(id,owner_id) VALUES($1,$2)", [
        randomUUID(),
        accountId,
      ]);
    } else if (challenge.delivery === "smtp")
      await c.query("UPDATE accounts SET email_verified_at=now() WHERE id=$1", [
        account.id,
      ]);
    await c.query("UPDATE login_challenges SET consumed_at=now() WHERE id=$1", [
      id,
    ]);
    const session = randomBytes(32).toString("base64url");
    await c.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')",
      [sha256(session), account.id],
    );
    return session;
  });
  if (!token)
    throw new Problem(
      401,
      "unauthorized",
      "Код неверен, истёк или уже использован. Запросите новый, если нужно.",
    );
  return token;
}
