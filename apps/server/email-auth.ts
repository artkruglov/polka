import type { PoolClient } from "pg";
import { trackSignup, type VisitSource } from "./analytics.ts";
import {
  randomBytes,
  randomInt,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { limitAttempts, passwordHash } from "./auth.ts";
import { assertNotDisposable, signupSpamKeys } from "./signup-guards.ts";
import { sha256 } from "./storage.ts";
import { Problem } from "./errors.ts";
import { domainAllowed } from "./mail-domains.ts";
import {
  LOCAL_MAIL_DIRECTORY,
  LOCAL_MAIL_NOTICE,
  sendSmtpMail,
  writeLocalMailFile,
} from "./mailer.ts";

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

// New shelves per day: counted when an account is created, in its transaction,
// so a refused attempt does not spend the budget. Starting a sign-in only
// looks, so a new visitor learns about a full day before waiting for a code.
const signupKeys = (ip: string, email: string | null) => [
  { key: "email-signup-day", max: () => config.EMAIL_SIGNUP_DAILY_LIMIT, message: "Сегодня на Полке уже открыто много новых полок. Регистрация продолжится завтра; если полка у вас уже есть, войдите." },
  { key: `email-signup-ip:${ip}`, max: () => config.EMAIL_SIGNUP_DAILY_PER_IP, message: "С этого подключения сегодня уже создано несколько полок. Попробуйте завтра." },
  // Anti-spam: per network and per mail domain (signup-guards.ts).
  // Anti-spam: per network and, with an address, per mail domain
  // (signup-guards.ts). Provider sign-ups count here too.
  ...signupSpamKeys(ip, email),
];

export async function signupRoomLeft(
  c: Pick<LocalDeliveryClient, "query">,
  ip: string,
  count: boolean,
  /** The new shelf's address, for the per-domain limit; null when none. */
  email: string | null = null,
) {
  for (const { key, max, message } of signupKeys(ip, email)) {
    const { rows } = count
      ? await c.query(
          `INSERT INTO login_limits VALUES($1,1,now()+interval '24 hours')
           ON CONFLICT(key) DO UPDATE SET
             attempts=CASE WHEN login_limits.reset_at<now() THEN 1 ELSE login_limits.attempts+1 END,
             reset_at=CASE WHEN login_limits.reset_at<now() THEN now()+interval '24 hours' ELSE login_limits.reset_at END
           RETURNING attempts, extract(epoch FROM reset_at-now())::float8 AS retry_after`,
          [sha256(key)],
        )
      : await c.query(
          "SELECT attempts+1 AS attempts, extract(epoch FROM reset_at-now())::float8 AS retry_after FROM login_limits WHERE key=$1 AND reset_at>now()",
          [sha256(key)],
        );
    if (Number(rows[0]?.attempts ?? 1) > max())
      throw new Problem(429, "quota", message).retryIn(Number(rows[0]?.retry_after ?? 86_400));
  }
}

/** In invite mode, an address listed exactly or by its @domain. */
export function emailInvited(email: string) {
  const domain = email.slice(email.lastIndexOf("@"));
  return config.EMAIL_SIGNUP_ALLOW.some(
    (entry) => entry === email || entry === domain,
  );
}

/**
 * Whether a code may open a NEW shelf for this address: the domain rule
 * (EMAIL_SIGNUP_DOMAINS) and invite mode. An address the operator listed in
 * EMAIL_SIGNUP_ALLOW is an invitation and passes both.
 */
export function emailSignupAllowed(email: string) {
  if (emailInvited(email)) return true;
  if (config.EMAIL_SIGNUP === "invite") return false;
  return domainAllowed(email, config.EMAIL_SIGNUP_DOMAINS);
}

/** Whether an EXISTING account may still get a code on this address. */
export function emailLoginAllowed(email: string) {
  return (
    config.EMAIL_LOGIN_DOMAINS === "any" ||
    emailInvited(email) ||
    domainAllowed(email, config.EMAIL_SIGNUP_DOMAINS)
  );
}

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
  const write = dependencies.write ?? writeLocalMailFile;
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
      `${LOCAL_MAIL_DIRECTORY}/${input.id}.json`,
      JSON.stringify(
        {
          email: input.email,
          code: input.code,
          expiresInSeconds: 600,
          notice: LOCAL_MAIL_NOTICE,
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
    // Invite-only installations and the sign-up domain rule send codes to
    // existing accounts and allowed addresses only. The answer is the same
    // either way, so the form does not tell a stranger which addresses have
    // a shelf; the interface explains the domain rule from /api/capabilities.
    const known = (
      await c.query("SELECT 1 FROM accounts WHERE email=$1", [email])
    ).rowCount;
    if (known) {
      if (!emailLoginAllowed(email)) return false;
    } else {
      if (!emailSignupAllowed(email)) return false;
      await assertNotDisposable(email);
      await signupRoomLeft(c, ip, false, email);
    }
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
      await sendSmtpMail({
        to: email,
        subject: "Код для входа в Полку",
        text: `Ваш код: ${code.slice(0, 4)} ${code.slice(4)}\nОн действует 10 минут. Если вы не запрашивали вход, проигнорируйте это письмо.`,
      });
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
export type EmailVerifyOptions = {
  /**
   * The browser is signed in to this provisional shelf (provisional.ts): an
   * address without a shelf is attached to it (a claim) instead of opening
   * another one.
   */
  provisionalId?: string | null;
  /**
   * The browser remembers another shelf (a localStorage hint): an address
   * without a shelf asks «войти в существующую или создать новую» first,
   * unless `createNew` says the person already chose.
   */
  knownShelf?: boolean;
  createNew?: boolean;
};

export type EmailVerifyResult =
  | { kind: "session"; session: string; accountId: string; created: boolean }
  | { kind: "claimed"; accountId: string }
  | { kind: "new-shelf" };

export async function verifyEmailLogin(
  id: string,
  code: string,
  browser: string,
  ip: string,
  source?: VisitSource | null,
  options: EmailVerifyOptions = {},
): Promise<EmailVerifyResult> {
  if (config.MAIL_MODE === "disabled")
    throw new Problem(503, "invalid", "Вход по почте отключён.");
  await limitAttempts(`email-verify-ip:${ip}`, 40);
  const result = await transaction(async (c): Promise<EmailVerifyResult | null> => {
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
    if (account && !emailLoginAllowed(challenge.email)) return null;
    let created = false;
    if (!account) {
      if (!emailSignupAllowed(challenge.email)) return null;
      if (options.provisionalId) {
        // The address claims the provisional shelf this browser holds.
        const claimed = await claimWithEmail(
          c,
          options.provisionalId,
          challenge.email,
          challenge.delivery === "smtp",
        );
        if (!claimed) return null;
        await c.query(
          "UPDATE login_challenges SET consumed_at=now() WHERE id=$1",
          [id],
        );
        return { kind: "claimed", accountId: options.provisionalId };
      }
      // The code is right and stays usable: the person answers the question
      // and sends it again with createNew, or signs in elsewhere.
      if (options.knownShelf && !options.createNew) return { kind: "new-shelf" };
      await signupRoomLeft(c, ip, true, challenge.email);
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
      trackSignup(c, accountId, "email", source);
      created = true;
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
    return { kind: "session", session, accountId: account.id, created };
  });
  if (!result)
    throw new Problem(
      401,
      "unauthorized",
      "Код неверен, истёк или уже использован. Запросите новый, если нужно.",
    );
  return result;
}

/**
 * Attaches a verified address to a provisional shelf (tenant, then account
 * locked) and marks it claimed. False when the shelf is gone or claimed.
 */
async function claimWithEmail(
  c: PoolClient,
  accountId: string,
  email: string,
  verified: boolean,
) {
  const tenant = (
    await c.query("SELECT id FROM tenants WHERE owner_id=$1 FOR UPDATE", [
      accountId,
    ])
  ).rows[0];
  const account = (
    await c.query(
      `SELECT id FROM accounts WHERE id=$1 AND provisional_at IS NOT NULL
         AND claimed_at IS NULL AND email IS NULL
         AND NOT disabled AND deletion_requested_at IS NULL FOR UPDATE`,
      [accountId],
    )
  ).rows[0];
  if (!tenant || !account) return false;
  await c.query(
    `UPDATE accounts SET email=$2,
            email_verified_at=CASE WHEN $3::boolean THEN now() ELSE NULL END
      WHERE id=$1`,
    [accountId, email, verified],
  );
  const { markClaimed } = await import("./provisional.ts");
  return markClaimed(c, accountId, "email", email.split("@")[0]);
}
