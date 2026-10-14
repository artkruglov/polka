import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { bodyBudget } from "../apps/server/admission.ts";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

// Bodies are admitted before they are read (apps/server/admission.ts): a
// bearer route refuses a request without a valid token unread, and one
// budget bounds the bytes all requests may hold in memory at once.
const app = await createApp();
let port = 0;
let secret = "";

before(async () => {
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.server.address() as AddressInfo).port;
  const owner = await createAccount(`admission-${randomBytes(5).toString("hex")}`, randomBytes(24).toString("hex"));
  secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
     VALUES($1,$2,$3,$4,'admission',$5,$6,now()+interval '1 day')`,
    [randomUUID(), owner.tenant, owner.id, sha256(secret), ["context", "capture", "sessions"], MCP_AUDIENCE],
  );
});

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

type Sent = { status: number; sent: number; headers: http.IncomingHttpHeaders; body: string };

/**
 * Declares `declared` bytes and sends at most `send` of them, then waits for
 * the answer. An answer that comes while the body is still incomplete was
 * given without reading it.
 */
function partialUpload(
  method: string,
  path: string,
  declared: number,
  send: number,
  headers: Record<string, string>,
  hold?: Promise<void>,
) {
  return new Promise<Sent>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        host: new URL(config.APP_ORIGIN).host,
        "content-length": String(declared),
        ...headers,
      },
    });
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, 32);
    const pump = () => {
      while (sent < send) {
        const part = chunk.subarray(0, Math.min(chunk.length, send - sent));
        sent += part.length;
        if (!req.write(part)) return void req.once("drain", pump);
      }
      if (sent === declared) req.end();
      else if (hold) void hold.then(() => req.destroy());
    };
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (part) => (body += part));
      res.on("end", () => {
        resolve({ status: res.statusCode!, sent, headers: res.headers, body });
        req.destroy();
      });
    });
    req.on("error", reject);
    pump();
  });
}

const MiB = 1024 * 1024;

test("a bearer route refuses a body without a valid token before reading it", async () => {
  const baseline = process.memoryUsage().arrayBuffers;
  const answers = await Promise.all(
    Array.from({ length: 8 }, () =>
      partialUpload("PUT", `/api/v1/sessions/${randomUUID()}/transcript`, 64 * MiB, MiB, {
        "content-type": "application/octet-stream",
        authorization: `Bearer ${"x".repeat(43)}`,
      }),
    ),
  );
  for (const answer of answers) {
    assert.equal(answer.status, 401);
    assert.match(String(answer.headers["www-authenticate"]), /invalid_token/);
    // The answer came with at least 63 MiB of the body never sent.
    assert.ok(answer.sent <= MiB);
    assert.equal(answer.headers.connection, "close");
  }
  // 8 × 64 MiB were declared; none of it was buffered.
  assert.ok(process.memoryUsage().arrayBuffers - baseline < 32 * MiB);
  assert.equal(bodyBudget().inFlight, 0);
  // No header at all: the same, without the token lookup.
  const bare = await partialUpload("POST", "/api/v1/publish", 8 * MiB, 64 * 1024, {
    "content-type": "application/json",
  });
  assert.equal(bare.status, 401);
});

test("/mcp refuses a body without a valid token before reading it", async () => {
  const answer = await partialUpload("POST", "/mcp", 8 * MiB, 64 * 1024, {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${"y".repeat(43)}`,
  });
  assert.equal(answer.status, 401);
  assert.match(String(answer.headers["www-authenticate"]), /invalid_token/);
  assert.equal(answer.headers.connection, "close");
  assert.ok(answer.sent <= 64 * 1024);
});

test("bodies past the in-flight budget get 503 with Retry-After until the budget frees", async () => {
  const before = bodyBudget().budget;
  bodyBudget(MiB);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  try {
    // An admitted upload that is still arriving holds its declared size.
    const first = partialUpload(
      "POST",
      "/api/v1/publish",
      768 * 1024,
      1024,
      { "content-type": "application/json", authorization: `Bearer ${secret}` },
      held,
    ).catch(() => null);
    for (let i = 0; i < 100 && bodyBudget().inFlight === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(bodyBudget().inFlight, 768 * 1024);
    const second = await partialUpload("POST", "/api/v1/publish", 768 * 1024, 1024, {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    });
    assert.equal(second.status, 503);
    assert.equal(second.headers["retry-after"], "5");
    assert.equal(JSON.parse(second.body).code, "busy");
    // A small request still fits.
    const small = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({});
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/v1/publish",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            authorization: `Bearer ${secret}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.notEqual(small, 503);
    release();
    await first;
    for (let i = 0; i < 100 && bodyBudget().inFlight !== 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(bodyBudget().inFlight, 0);
  } finally {
    release();
    bodyBudget(before);
  }
});

/** Starts `count` uploads that declare `declared` bytes, send `send` and hold until `hold`. */
function slowSenders(count: number, path: string, declared: number, send: number, hold: Promise<void>) {
  return Array.from({ length: count }, () =>
    partialUpload(
      "POST",
      path,
      declared,
      send,
      { "content-type": "application/json", origin: config.APP_ORIGIN },
      hold,
    ).catch(() => null),
  );
}

const settle = async (until: () => boolean) => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 20));
};

test("slow anonymous senders hold only the bytes they sent, not what they declare", async () => {
  const before = bodyBudget().budget;
  bodyBudget(16 * MiB);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  try {
    // 52 requests declare 5 MiB each (16 times the whole budget) to an
    // unmatched route and to a cookie route, then send 1 KiB and stall.
    const stalled = [
      ...slowSenders(26, `/api/no-such-route-${randomUUID()}`, 5 * MiB, 1024, held),
      ...slowSenders(26, "/api/artifacts", 5 * MiB, 1024, held),
    ];
    await settle(() => bodyBudget().inFlight >= 52 * 1024);
    assert.equal(bodyBudget().inFlight, 52 * 1024);
    assert.equal(bodyBudget().anonymous.inFlight, 52 * 1024);
    // A checked upload of 8 MiB is still admitted and read.
    const real = await new Promise<number>((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ pad: "x".repeat(8 * MiB) }));
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/v1/sessions",
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            authorization: `Bearer ${secret}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.notEqual(real, 503);
    release();
    await Promise.all(stalled);
    await settle(() => bodyBudget().inFlight === 0);
    assert.equal(bodyBudget().inFlight, 0);
    assert.equal(bodyBudget().anonymous.inFlight, 0);
    assert.equal(bodyBudget().addresses, 0);
  } finally {
    release();
    bodyBudget(before);
  }
});

test("anonymous bytes from one address are capped while another of its bodies is in flight", async () => {
  const before = bodyBudget().budget;
  bodyBudget(16 * MiB); // anonymous: 4 MiB in all, 1 MiB from one address
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  try {
    const [first] = slowSenders(1, `/api/no-such-route-${randomUUID()}`, 5 * MiB, 768 * 1024, held);
    await settle(() => bodyBudget().anonymous.inFlight >= 768 * 1024);
    assert.equal(bodyBudget().anonymous.inFlight, 768 * 1024);
    const refusedBefore = bodyBudget().refused;
    const second = await partialUpload("POST", `/api/no-such-route-${randomUUID()}`, 5 * MiB, 512 * 1024, {
      "content-type": "application/json",
      origin: config.APP_ORIGIN,
    });
    assert.equal(second.status, 503);
    assert.equal(second.headers["retry-after"], "5");
    assert.equal(second.headers.connection, "close");
    assert.equal(JSON.parse(second.body).code, "busy");
    assert.ok(bodyBudget().refused > refusedBefore);
    // A small anonymous request still fits.
    const small = await partialUpload("POST", `/api/no-such-route-${randomUUID()}`, 1024, 1024, {
      "content-type": "application/json",
      origin: config.APP_ORIGIN,
    });
    assert.notEqual(small.status, 503);
    release();
    await first;
    await settle(() => bodyBudget().inFlight === 0);
    assert.equal(bodyBudget().inFlight, 0);
    assert.equal(bodyBudget().addresses, 0);
  } finally {
    release();
    bodyBudget(before);
  }
});
