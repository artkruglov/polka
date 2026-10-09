#!/usr/bin/env node
// External check of a running installation, to run on a schedule from a
// machine outside it: the app answers, the viewer domain answers over TLS,
// neither certificate is close to expiry, and (with OPS_STATUS_TOKEN) the
// operator status is green. Exits 1 when anything is wrong.
//
// Output and alerts may land in shared logs and chats: they name only
// checks and ok/fail, never status details or response bodies.
//
// Env: APP_ORIGIN (required), VIEWER_ORIGIN, OPS_STATUS_TOKEN.
// Alerts, sent only when the set of failing checks changes (a new failure,
// or recovery), so a cron every few minutes does not repeat them:
//   ALERT_WEBHOOK_URL — POST {"text": …} (Slack, Mattermost and compatible);
//   TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID — a message from a Telegram bot;
//   UPTIME_STATE_FILE — where the last result is kept
//     (default: .polka-uptime-state.json in the home directory).
// UPTIME_PAUSE_MS shortens the pause between tries (tests).
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";

const app = process.env.APP_ORIGIN;
const viewer = process.env.VIEWER_ORIGIN;
const token = process.env.OPS_STATUS_TOKEN;
if (!app) throw new Error("APP_ORIGIN is required");

const CERT_MIN_DAYS = 14;
const ATTEMPTS = 3;
const PAUSE_MS = Number(process.env.UPTIME_PAUSE_MS ?? 20_000);
const STATE_FILE = process.env.UPTIME_STATE_FILE || join(homedir(), ".polka-uptime-state.json");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  await response.arrayBuffer();
  return response.status;
}

function certificateDays(origin) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) || 443, servername: hostname, timeout: 15_000 }, () => {
      const expires = Date.parse(socket.getPeerCertificate().valid_to);
      socket.end();
      resolve((expires - Date.now()) / 86_400_000);
    });
    socket.on("error", reject);
    socket.on("timeout", () => socket.destroy(new Error("TLS timeout")));
  });
}

const https = (origin) => new URL(origin).protocol === "https:";
const checks = [
  ["app health", async () => (await get(`${app}/api/health`)) === 200],
  ["app front page", async () => (await get(`${app}/`)) === 200],
];
if (https(app)) checks.push(["app certificate", async () => (await certificateDays(app)) > CERT_MIN_DAYS]);
if (viewer) {
  // The viewer has no front page: any answer below 500 means it is serving.
  checks.push(["viewer answers", async () => (await get(`${viewer}/`)) < 500]);
  if (https(viewer)) checks.push(["viewer certificate", async () => (await certificateDays(viewer)) > CERT_MIN_DAYS]);
}
if (token)
  checks.push([
    "operator status",
    async () => (await get(`${app}/api/ops/status`, { authorization: `Bearer ${token}` })) === 200,
  ]);

// A single dropped request is not an outage: each check gets three tries.
async function passes(check) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      if (await check()) return true;
    } catch {
      // Network error or timeout: retry like a failed check.
    }
    if (attempt < ATTEMPTS) await pause(PAUSE_MS);
  }
  return false;
}

const failing = [];
for (const [name, check] of checks) {
  const ok = await passes(check);
  if (!ok) failing.push(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}
if (failing.length) {
  console.log(`${failing.length} of ${checks.length} checks failed`);
  process.exitCode = 1;
}
await alert(failing);

/** Tells the operator when the failing checks differ from the last run. */
async function alert(failing) {
  const webhook = process.env.ALERT_WEBHOOK_URL;
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!webhook && !(bot && chat)) return;
  let before = [];
  try {
    before = JSON.parse(await readFile(STATE_FILE, "utf8")).failing ?? [];
  } catch {
    // First run, or the file is gone: nothing was failing.
  }
  if (before.join("\n") === failing.join("\n")) return;
  const host = new URL(app).host;
  const text = failing.length
    ? `Полка ${host}: не проходит — ${failing.join(", ")}`
    : `Полка ${host}: все проверки снова проходят`;
  const sends = [];
  if (webhook) sends.push(post(webhook, { text }));
  if (bot && chat) sends.push(post(`https://api.telegram.org/bot${bot}/sendMessage`, { chat_id: chat, text }));
  const sent = await Promise.all(sends);
  // Kept only once every alert went out, so a failed one is sent again next run.
  if (sent.every(Boolean)) await writeFile(STATE_FILE, JSON.stringify({ failing, at: new Date().toISOString() }));
  else {
    console.log("alert not delivered");
    process.exitCode = 1;
  }
}

async function post(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}
