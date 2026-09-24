// Requests from the page for companies (/enterprise). Anyone may ask; the
// request is stored (enterprise_requests, deleted by maintenance after a
// year) and sent to OPERATOR_EMAIL as a plain-text letter. The browser-POST
// Origin check in app.ts applies; the limit counts per hashed client IP.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  EnterpriseInterest,
  EnterpriseTeamSize,
} from "../../packages/contracts/constants.ts";
import { enterpriseRequestSchema } from "../../packages/contracts/enterprise.ts";
import { limitAttempts } from "./auth.ts";
import { trackEnterpriseRequest } from "./analytics.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { Problem } from "./errors.ts";
import { sendMail } from "./mailer.ts";

/** Requests per client IP per hour. */
export const ENTERPRISE_REQUESTS_PER_IP = 5;
/** Requests from everyone per day: a flood never buries the operator's mailbox. */
export const ENTERPRISE_REQUESTS_PER_DAY = 200;

export const TEAM_SIZE_LABEL: Record<EnterpriseTeamSize, string> = {
  "1-10": "до 10 человек",
  "11-50": "11–50 человек",
  "51-200": "51–200 человек",
  "201-1000": "201–1000 человек",
  "1000+": "больше 1000 человек",
};
export const INTEREST_LABEL: Record<EnterpriseInterest, string> = {
  cloud: "облако polochka.app",
  "self-hosted": "своя установка",
  "commercial-license": "коммерческая лицензия",
  other: "другое",
};

type StoredRequest = {
  id: string;
  name: string;
  company: string;
  email: string;
  team_size: EnterpriseTeamSize;
  interest: EnterpriseInterest;
  comment: string | null;
  created_at: Date;
};

/** The operator's letter: plain text only, the fields exactly as sent. */
export function enterpriseLetter(request: StoredRequest) {
  const when = request.created_at.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
  });
  return {
    subject: `Заявка «Для компаний»: ${request.company}`.slice(0, 200),
    text: [
      "Новая заявка со страницы «Для компаний» (/enterprise).",
      "",
      `Имя: ${request.name}`,
      `Компания: ${request.company}`,
      `Рабочая почта: ${request.email}`,
      `Размер команды: ${TEAM_SIZE_LABEL[request.team_size]}`,
      `Что интересует: ${INTEREST_LABEL[request.interest]}`,
      "",
      "Комментарий:",
      request.comment || "—",
      "",
      "—",
      `Заявка ${request.id}, ${when} (МСК).`,
      "Человек подтвердил, что прочитал Политику обработки персональных данных.",
      "Ответьте на рабочую почту из заявки. Запись удаляется автоматически через год.",
    ].join("\n"),
    replyTo: request.email,
  };
}

export async function createEnterpriseRequest(body: unknown, ip: string) {
  const input = enterpriseRequestSchema.parse(body);
  await limitAttempts(
    `enterprise:ip:${ip}`,
    ENTERPRISE_REQUESTS_PER_IP,
    "1 hour",
  );
  // A filled honeypot is a bot: it sees the same answer and nothing is kept.
  if (input.website?.trim()) return { ok: true as const };
  await limitAttempts(
    "enterprise:all",
    ENTERPRISE_REQUESTS_PER_DAY,
    "24 hours",
  );
  const comment = input.comment || null;
  const {
    rows: [created],
  } = await db.query<StoredRequest>(
    `INSERT INTO enterprise_requests(
       id,idempotency_key,name,company,email,team_size,interest,comment
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(idempotency_key) DO NOTHING
     RETURNING id,name,company,email,team_size,interest,comment,created_at`,
    [
      randomUUID(),
      input.key,
      input.name,
      input.company,
      input.email,
      input.teamSize,
      input.interest,
      comment,
    ],
  );
  if (!created) {
    const {
      rows: [old],
    } = await db.query(
      `SELECT name,company,email,team_size,interest,comment
       FROM enterprise_requests WHERE idempotency_key=$1`,
      [input.key],
    );
    if (
      !old ||
      old.name !== input.name ||
      old.company !== input.company ||
      old.email !== input.email ||
      old.team_size !== input.teamSize ||
      old.interest !== input.interest ||
      old.comment !== comment
    )
      throw new Problem(
        409,
        "conflict",
        "Этот повтор относится к другой заявке. Отправьте форму заново.",
      );
    return { ok: true as const };
  }
  // Analytics: that a request came, and what about; nothing about who.
  trackEnterpriseRequest(created.interest, created.team_size);
  await notifyOperator(created);
  return { ok: true as const };
}

/** Never fails the request: it is stored, and the operator can read the table. */
async function notifyOperator(request: StoredRequest) {
  if (!config.OPERATOR_EMAIL || config.MAIL_MODE === "disabled") return;
  try {
    await sendMail({ to: config.OPERATOR_EMAIL, ...enterpriseLetter(request) });
    await db.query(
      "UPDATE enterprise_requests SET notified_at=now() WHERE id=$1",
      [request.id],
    );
  } catch {
    console.error(JSON.stringify({ event: "enterprise_request.mail_failed" }));
  }
}

export function registerEnterpriseRequests(app: FastifyInstance) {
  app.post("/api/enterprise-requests", { bodyLimit: 16384 }, async (req) =>
    createEnterpriseRequest(req.body, req.ip),
  );
}
