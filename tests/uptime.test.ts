import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/ci/uptime.mjs: alerts go out when the failing checks change, and
// are sent again next run when delivery failed.

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

function run(env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ["scripts/ci/uptime.mjs"], {
      env: { PATH: process.env.PATH ?? "", UPTIME_PAUSE_MS: "1", ...env },
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("uptime alerts once per change of the failing checks", async () => {
  let healthy = false;
  const app = createServer((req, res) => {
    res.statusCode = req.url === "/api/health" && !healthy ? 500 : 200;
    res.end();
  });
  const alerts: string[] = [];
  let webhookUp = true;
  const hook = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (webhookUp) alerts.push(JSON.parse(body).text);
      res.statusCode = webhookUp ? 200 : 503;
      res.end();
    });
  });
  const dir = await mkdtemp(join(tmpdir(), "polka-uptime-"));
  try {
    const env = {
      APP_ORIGIN: await listen(app),
      ALERT_WEBHOOK_URL: await listen(hook),
      UPTIME_STATE_FILE: join(dir, "state.json"),
    };

    const down = await run(env);
    assert.equal(down.code, 1, down.out);
    assert.match(down.out, /FAIL app health/);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /не проходит — app health$/);

    // Still down: the operator already knows.
    assert.equal((await run(env)).code, 1);
    assert.equal(alerts.length, 1);

    // Recovered, but the alert could not be delivered: it is sent next run.
    healthy = true;
    webhookUp = false;
    const undelivered = await run(env);
    assert.equal(undelivered.code, 1, undelivered.out);
    assert.match(undelivered.out, /alert not delivered/);
    webhookUp = true;
    const up = await run(env);
    assert.equal(up.code, 0, up.out);
    assert.equal(alerts.length, 2);
    assert.match(alerts[1], /все проверки снова проходят/);

    assert.equal((await run(env)).code, 0);
    assert.equal(alerts.length, 2);
  } finally {
    app.close();
    hook.close();
    await rm(dir, { recursive: true, force: true });
  }
});
