// scripts/ci/uptime.mjs on a timer, outside the installation's VM (Yandex
// Cloud Functions; see README.md here). Each run executes the same checks,
// and mails the operator when the set of failing checks changes: a new
// failure, or everything passing again. The last result is kept in a small
// bucket, since a function keeps nothing between runs. The letter names
// only checks, never response bodies.
//
// Env: APP_ORIGIN, VIEWER_ORIGIN, OPS_STATUS_TOKEN (the checks);
// ALERT_TO, MAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (the
// letter); STATE_BUCKET, S3_KEY_ID, S3_SECRET (the last result).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import nodemailer from "nodemailer";

const run = promisify(execFile);
const STATE_KEY = "uptime/state.json";
const env = process.env;

const s3 = new S3Client({
  endpoint: "https://storage.yandexcloud.net",
  region: "ru-central1",
  credentials: { accessKeyId: env.S3_KEY_ID, secretAccessKey: env.S3_SECRET },
});

async function checks() {
  const { stdout } = await run(process.execPath, ["uptime.mjs"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      APP_ORIGIN: env.APP_ORIGIN,
      VIEWER_ORIGIN: env.VIEWER_ORIGIN ?? "",
      OPS_STATUS_TOKEN: env.OPS_STATUS_TOKEN ?? "",
      UPTIME_PAUSE_MS: env.UPTIME_PAUSE_MS ?? "10000",
    },
    timeout: 480_000,
  }).catch((error) => error); // exit 1 is a failing check, not an error
  const lines = String(stdout ?? "").split("\n");
  const names = lines.filter((line) => /^(ok  |FAIL) /.test(line));
  // The script did not run at all: that is a failure to report too.
  if (!names.length) return ["uptime check did not run"];
  return names.filter((line) => line.startsWith("FAIL")).map((line) => line.slice(5));
}

async function previous() {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: env.STATE_BUCKET, Key: STATE_KEY }));
    return JSON.parse(await object.Body.transformToString()).failing ?? [];
  } catch {
    return [];
  }
}

export async function handler() {
  const failing = await checks();
  const before = await previous();
  if (before.join("\n") === failing.join("\n")) return { failing, alerted: false };
  const host = new URL(env.APP_ORIGIN).host;
  const subject = failing.length
    ? `Полка ${host}: не проходит — ${failing.join(", ")}`
    : `Полка ${host}: все проверки снова проходят`;
  await nodemailer
    .createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT ?? 587),
      secure: Number(env.SMTP_PORT) === 465,
      requireTLS: true,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    })
    .sendMail({
      from: env.MAIL_FROM,
      to: env.ALERT_TO,
      subject,
      text: `${subject}\n\n${new Date().toISOString()}\nПроверки: scripts/ci/uptime.mjs (приложение, домен просмотра, сертификаты, /api/ops/status).\n`,
    });
  // Kept only after the letter went out, so a failed one is sent next run.
  await s3.send(
    new PutObjectCommand({
      Bucket: env.STATE_BUCKET,
      Key: STATE_KEY,
      Body: JSON.stringify({ failing, at: new Date().toISOString() }),
      ContentType: "application/json",
    }),
  );
  return { failing, alerted: true };
}
