// The one place Полка sends mail from: sign-in codes (email-auth.ts) and
// operator moderation (moderation-mail.ts), comment letters (comment-mail.ts).
// MAIL_MODE=smtp sends through
// SMTP_*; MAIL_MODE=local never sends and writes a JSON file under
// .local/mail instead (loopback installations and tests read it there).
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import nodemailer from "nodemailer";
import { config } from "./config.ts";

export type Mail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

/** Sign-in codes are written as `.local/mail/<challenge id>.json`. */
export const LOCAL_MAIL_DIRECTORY = ".local/mail";
/** Operator mail in local mode: one JSON file per message. */
export const LOCAL_OPERATOR_MAIL_DIRECTORY = ".local/mail/operator";
/** Letters about comments to owners and thread participants, local mode. */
export const LOCAL_COMMENT_MAIL_DIRECTORY = ".local/mail/comments";

export const LOCAL_MAIL_NOTICE = "LOCAL TEST ONLY — not delivered";

/** A new file only (never overwrites), readable by this user alone. */
export async function writeLocalMailFile(path: string, body: string) {
  await mkdir(path.slice(0, path.lastIndexOf("/")), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(path, body, { flag: "wx", mode: 0o600 });
}

/** One SMTP message; throws when the server does not accept it. */
export async function sendSmtpMail(mail: Mail) {
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
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    ...(mail.html ? { html: mail.html } : {}),
  });
  if (!result.accepted.length) throw new Error("Mail not accepted");
}

/**
 * Sends one message the way this installation is configured. Returns false
 * when mail is disabled. Local mode returns the written file's path.
 */
export async function sendMail(
  mail: Mail,
  localDirectory = LOCAL_OPERATOR_MAIL_DIRECTORY,
): Promise<string | boolean> {
  if (config.MAIL_MODE === "disabled") return false;
  if (config.MAIL_MODE === "local") {
    const path = `${localDirectory}/${Date.now()}-${randomUUID()}.json`;
    await writeLocalMailFile(
      path,
      JSON.stringify({ ...mail, notice: LOCAL_MAIL_NOTICE }, null, 2),
    );
    return path;
  }
  await sendSmtpMail(mail);
  return true;
}
