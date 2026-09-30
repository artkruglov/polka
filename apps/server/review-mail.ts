// Letters to the author about a link that waits for review
// (docs/specs/LINK_REVIEW_LETTERS.md). Until now only the operator was written
// to: the author learned that recipients saw «на проверке» from the recipients.
//
// Two letters, each once per round: the link waits (after a few minutes, so a
// link the model releases by itself is never mentioned), and it was approved.
// A blocked link is not written about here: the owner sees it on the work with
// where to appeal, and what the filter found is not something to explain.
// The letter names no signal or finding, only that a person looks at it.
import { config } from "./config.ts";
import { limitAttempts } from "./auth.ts";
import { db, transaction } from "./db.ts";
import { sendMail } from "./mailer.ts";
import { clean } from "./moderation.ts";

/** A held link is told about after this long, so one released at once is not. */
const GRACE_MINUTES = 3;
const PER_ADDRESS_PER_DAY = 6;
const BATCH = 10;

type Transport = (mail: { to: string; subject: string; text: string }) => Promise<string | boolean>;
let transport: Transport = (mail) => sendMail(mail);
/** Tests: replace how the letters leave (undefined: sendMail). */
export function setReviewMailTransport(next: Transport | undefined) {
  transport = next ?? ((mail) => sendMail(mail));
}

const workUrl = (artifactId: string) => `${config.APP_ORIGIN}/works/${artifactId}`;
const contact = () =>
  config.OPERATOR_CONTACT ?? config.OPERATOR_EMAIL
    ? ` Если вопросов больше, чем ответов, напишите на ${config.OPERATOR_CONTACT ?? config.OPERATOR_EMAIL}.`
    : "";

export function heldLetter(title: string, artifactId: string) {
  return {
    subject: `Полка: ссылка на «${title}» на проверке`,
    text: [
      `Вы отправили ссылку на работу «${title}», и Полка держит её на проверке.`,
      "",
      "Полка проверяет часть ссылок вручную, прежде чем их откроют: ссылки новых аккаунтов, страницы, похожие на поддельные, и ссылки, на которые пожаловались. Пока идёт проверка, получатели видят экран «Ссылка на проверке», содержимое им не показывается.",
      "",
      "Если проверка пройдёт, работа откроется по той же ссылке: отправлять её заново не нужно, а экран у получателя обновится сам. Мы напишем, когда решение будет принято.",
      contact().trim(),
      "",
      `Работа: ${workUrl(artifactId)}`,
    ]
      .filter((line, index, all) => line || all[index - 1])
      .join("\n"),
  };
}

export function releasedLetter(title: string, artifactId: string) {
  return {
    subject: `Полка: ссылка на «${title}» одобрена`,
    text: [
      `Проверка ссылки на работу «${title}» закончена, ссылка открывается. Получатели видят работу.`,
      "",
      `Работа: ${workUrl(artifactId)}`,
    ].join("\n"),
  };
}

const AUTHOR_SQL = `
  JOIN artifacts artifact ON artifact.id=share.artifact_id AND artifact.trashed_at IS NULL
  JOIN tenants tenant ON tenant.id=share.tenant_id
  JOIN accounts author ON author.id=COALESCE(tenant.owner_id,share.created_by)
    AND author.email IS NOT NULL AND NOT author.disabled AND author.deletion_requested_at IS NULL`;

async function deliver(to: string, letter: { subject: string; text: string }) {
  try {
    await limitAttempts(`review-mail:${to.toLowerCase()}`, PER_ADDRESS_PER_DAY, "24 hours");
  } catch {
    return false;
  }
  return !!(await transport({ to, ...letter }));
}

/**
 * One pass (the app runs it every few minutes; safe with several instances:
 * a row is locked while its letter is written). Returns how many letters left.
 */
export async function sendReviewLetters() {
  if (config.MAIL_MODE === "disabled") return 0;
  let sent = 0;
  // A link that waits: the first round, or a new one after a completed round.
  await transaction(async (c) => {
    const { rows } = await c.query(
      `SELECT share.id,share.artifact_id,artifact.title,author.email
       FROM shares share ${AUTHOR_SQL}
       WHERE share.moderation IN ('held','paused') AND NOT share.revoked AND share.expires_at>now()
         AND (share.moderation_reason IS NULL OR share.moderation_reason NOT LIKE 'spam:%')
         AND COALESCE(share.moderated_at,share.created_at)<now()-make_interval(mins=>$1)
         AND (share.review_notified_at IS NULL OR share.release_notified_at IS NOT NULL)
       ORDER BY COALESCE(share.moderated_at,share.created_at) LIMIT $2
       FOR UPDATE OF share SKIP LOCKED`,
      [GRACE_MINUTES, BATCH],
    );
    for (const row of rows) {
      if (!(await deliver(row.email, heldLetter(clean(row.title, 120) || "Без названия", row.artifact_id)))) continue;
      await c.query("UPDATE shares SET review_notified_at=now(),release_notified_at=NULL WHERE id=$1", [row.id]);
      sent++;
    }
  });
  // A link that was told to wait and now opens.
  await transaction(async (c) => {
    const { rows } = await c.query(
      `SELECT share.id,share.artifact_id,artifact.title,author.email
       FROM shares share ${AUTHOR_SQL}
       WHERE share.moderation='none' AND NOT share.revoked AND share.expires_at>now()
         AND share.review_notified_at IS NOT NULL AND share.release_notified_at IS NULL
       ORDER BY share.moderated_at LIMIT $1
       FOR UPDATE OF share SKIP LOCKED`,
      [BATCH],
    );
    for (const row of rows) {
      if (!(await deliver(row.email, releasedLetter(clean(row.title, 120) || "Без названия", row.artifact_id)))) continue;
      await c.query("UPDATE shares SET release_notified_at=now() WHERE id=$1", [row.id]);
      sent++;
    }
  });
  return sent;
}
