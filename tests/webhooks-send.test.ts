// How a webhook leaves (apps/server/webhook-send.ts, docs/specs/WEBHOOKS.md):
// the signature a receiver checks, the secret kept encrypted, and the address
// check against SSRF before any connection.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import {
  newWebhookSecret,
  openWebhookSecret,
  postTo,
  postWebhook,
  resolveWebhookTarget,
  sealWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
  webhookRequest,
  webhookUrl,
  WebhookUrlError,
} from "../apps/server/webhook-send.ts";

const resolveTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

test("the signature is HMAC-SHA256 over «t.body» with the secret, and a receiver can check it", () => {
  const secret = "whsec_test";
  const body = '{"id":"1:2","action":"revision.saved"}';
  const header = signWebhook(secret, 1_760_000_000, body);
  const expected = createHmac("sha256", secret).update(`1760000000.${body}`).digest("hex");
  assert.equal(header, `t=1760000000,v1=${expected}`);
  assert.equal(verifyWebhookSignature(secret, header, body, 1_760_000_100), true);
  // Another body, another secret, a stale timestamp or a cut signature fail.
  assert.equal(verifyWebhookSignature(secret, header, `${body} `, 1_760_000_100), false);
  assert.equal(verifyWebhookSignature("whsec_other", header, body, 1_760_000_100), false);
  assert.equal(verifyWebhookSignature(secret, header, body, 1_760_000_000 + 301), false);
  assert.equal(verifyWebhookSignature(secret, header.slice(0, -2), body, 1_760_000_100), false);
  assert.equal(verifyWebhookSignature(secret, "garbage", body, 1_760_000_100), false);
});

test("a request carries the event, its id and a fresh signature", () => {
  const secret = newWebhookSecret();
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  const payload = { id: "5:9", action: "share.enabled", artifactId: "a", actorType: "human", at: "now" };
  const request = webhookRequest(
    "https://hooks.example.com/x",
    secret,
    { id: "d1", action: "share.enabled", payload },
    42,
  );
  assert.equal(request.body, JSON.stringify(payload));
  assert.equal(request.headers["Polka-Event"], "share.enabled");
  assert.equal(request.headers["Polka-Delivery"], "d1");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(verifyWebhookSignature(secret, request.headers["Polka-Signature"]!, request.body, 42), true);
});

test("the secret is stored encrypted, bound to its webhook, and opens only with the installation's key", () => {
  const secret = newWebhookSecret();
  const id = randomUUID();
  const sealed = sealWebhookSecret(secret, id);
  assert.ok(!sealed.includes(Buffer.from(secret)));
  assert.notDeepEqual(sealWebhookSecret(secret, id), sealed, "a fresh IV every time");
  assert.equal(openWebhookSecret(sealed, id), secret);
  // Copied to another webhook's row, it does not open.
  assert.throws(() => openWebhookSecret(sealed, randomUUID()));
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => openWebhookSecret(tampered, id));
});

test("the addresses are tried IPv4 first, at most four", async () => {
  const target = await resolveWebhookTarget(
    "https://hooks.example.com/x",
    resolveTo("2606:4700:4700::1111", "93.184.216.34", "2606:4700:4700::1001", "1.1.1.1", "8.8.8.8", "8.8.4.4"),
  );
  assert.deepEqual(
    target.addresses.map((entry) => entry.address),
    ["93.184.216.34", "1.1.1.1", "8.8.8.8", "8.8.4.4"],
  );
  assert.equal(target.address, "93.184.216.34");
});

test("only https on 443 without a login, and no internal names", () => {
  assert.equal(webhookUrl(" https://hooks.example.com/polka#x ").href, "https://hooks.example.com/polka");
  for (const bad of [
    "http://hooks.example.com/",
    "ftp://hooks.example.com/",
    "https://user:pass@hooks.example.com/",
    "https://hooks.example.com:8443/",
    "https://localhost/",
    "https://api.localhost/",
    "https://printer.local/",
    "https://metadata.google.internal/",
    "https://intranet/",
    "not a url",
  ])
    assert.throws(() => webhookUrl(bad), WebhookUrlError, bad);
});

test("an address that resolves to anything private, loopback, link-local or metadata is refused", async () => {
  for (const [url, addresses] of [
    ["https://hooks.example.com/", ["127.0.0.1"]],
    ["https://hooks.example.com/", ["10.1.2.3"]],
    ["https://hooks.example.com/", ["172.16.0.5"]],
    ["https://hooks.example.com/", ["192.168.1.1"]],
    ["https://hooks.example.com/", ["169.254.169.254"]],
    ["https://hooks.example.com/", ["100.64.0.1"]],
    ["https://hooks.example.com/", ["::1"]],
    ["https://hooks.example.com/", ["fc00::1"]],
    ["https://hooks.example.com/", ["fe80::1"]],
    ["https://hooks.example.com/", ["::ffff:127.0.0.1"]],
    // One public answer among private ones is still refused.
    ["https://hooks.example.com/", ["93.184.216.34", "10.0.0.1"]],
  ] as const)
    await assert.rejects(
      resolveWebhookTarget(url, resolveTo(...addresses)),
      { code: "blocked_address" },
      `${addresses}`,
    );
  for (const literal of [
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "https://[fd00::1]/",
  ])
    await assert.rejects(resolveWebhookTarget(literal, resolveTo("8.8.8.8")), { code: "blocked_address" }, literal);
  await assert.rejects(
    resolveWebhookTarget("https://hooks.example.com/", async () => {
      throw new Error("ENOTFOUND");
    }),
    { code: "dns" },
  );
  const ok = await resolveWebhookTarget("https://hooks.example.com/x", resolveTo("93.184.216.34"));
  assert.equal(ok.address, "93.184.216.34");
});

test("postWebhook connects to nothing when the name turns private (DNS rebinding)", async () => {
  let asked = 0;
  const result = await postWebhook({ url: "https://hooks.example.com/x", body: "{}", headers: {} }, async () => {
    asked++;
    return [{ address: "127.0.0.1", family: 4 }];
  });
  assert.equal(asked, 1);
  assert.deepEqual(result, { ok: false, status: null, error: "blocked_address", snippet: null });
});

test("postTo survives an address the host has no route to", async () => {
  // 100::/64 is discard-only: on a host without that route the connect fails
  // at once. With the lookup answered synchronously that failure escaped as
  // an uncaught EHOSTUNREACH and the server exited (0.15.0 on polochka.app,
  // which has no IPv6). Where the address is routable it fails later; either
  // way the attempt ends as a "connection" or "timeout" result.
  const result = await postTo(
    new URL("https://hooks.example.com/x"),
    { address: "100::1", family: 6 },
    "{}",
    {},
    AbortSignal.timeout(2000),
  );
  assert.equal(result.ok, false);
  assert.ok(["connection", "timeout"].includes(result.error ?? ""), String(result.error));
  await new Promise((resolve) => setTimeout(resolve, 100));
});
