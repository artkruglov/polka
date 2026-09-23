#!/usr/bin/env node
// External check of a running installation, to run on a schedule from a
// machine outside it: the app answers, the viewer domain answers over TLS,
// neither certificate is close to expiry, and (with OPS_STATUS_TOKEN) the
// operator status is green. Exits 1 when anything is wrong.
//
// Output may land in shared logs: print only check names and ok/fail, never
// status details or response bodies.
//
// Env: APP_ORIGIN (required), VIEWER_ORIGIN, OPS_STATUS_TOKEN.
import { connect } from "node:tls";

const app = process.env.APP_ORIGIN;
const viewer = process.env.VIEWER_ORIGIN;
const token = process.env.OPS_STATUS_TOKEN;
if (!app) throw new Error("APP_ORIGIN is required");

const CERT_MIN_DAYS = 14;
const ATTEMPTS = 3;
const PAUSE_MS = 20_000;

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
    const socket = connect(
      { host: hostname, port: Number(port) || 443, servername: hostname, timeout: 15_000 },
      () => {
        const expires = Date.parse(socket.getPeerCertificate().valid_to);
        socket.end();
        resolve((expires - Date.now()) / 86_400_000);
      },
    );
    socket.on("error", reject);
    socket.on("timeout", () => socket.destroy(new Error("TLS timeout")));
  });
}

const checks = [
  ["app health", async () => (await get(`${app}/api/health`)) === 200],
  ["app front page", async () => (await get(`${app}/`)) === 200],
  ["app certificate", async () => (await certificateDays(app)) > CERT_MIN_DAYS],
];
if (viewer)
  checks.push(
    // The viewer has no front page: any answer below 500 means it is serving.
    ["viewer answers", async () => (await get(`${viewer}/`)) < 500],
    ["viewer certificate", async () => (await certificateDays(viewer)) > CERT_MIN_DAYS],
  );
if (token)
  checks.push([
    "operator status",
    async () =>
      (await get(`${app}/api/ops/status`, { authorization: `Bearer ${token}` })) === 200,
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

let failed = 0;
for (const [name, check] of checks) {
  const ok = await passes(check);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}
if (failed) {
  console.log(`${failed} of ${checks.length} checks failed`);
  process.exitCode = 1;
}
