import test from "node:test";
import assert from "node:assert/strict";
import {
  publicAddress,
  publicUrl,
  resolvePublicTarget,
  ImportFetchError,
} from "../apps/server/url-import/public-fetch.ts";
test("URL importer rejects local, reserved, mapped and transition addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fe80::1",
    "2002:0808:0808::1",
    "2001:db8::1",
    "3fff::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(publicAddress(ip), true, ip);
});
test("URL importer canonicalizes encoded IPs and rejects credentials and ports", async () => {
  for (const url of ["http://example.org", "https://u:p@example.org", "https://example.org:444", "file:///etc/passwd"])
    assert.throws(() => publicUrl(url), ImportFetchError);
  for (const url of ["https://2130706433", "https://0x7f000001", "https://[::1]"])
    await assert.rejects(resolvePublicTarget(url), { code: "blocked_address" });
  assert.equal(publicUrl("https://example.org/a#fragment").href, "https://example.org/a");
});
test("mixed DNS answers fail closed, public target preserves hostname and pins address", async () => {
  await assert.rejects(
    resolvePublicTarget("https://example.org", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    { code: "blocked_address" },
  );
  const result = await resolvePublicTarget("https://example.org/a", async () => [{ address: "8.8.8.8", family: 4 }]);
  assert.equal(result.url.hostname, "example.org");
  assert.equal(result.address, "8.8.8.8");
});

test("fetch entry point rejects a metadata URL before making a connection", async () => {
  const { fetchPublic } = await import("../apps/server/url-import/public-fetch.ts");
  await assert.rejects(fetchPublic("https://169.254.169.254/latest/meta-data/"), { code: "blocked_address" });
  // A pre-aborted signal stops before any DNS lookup: no network, no orphaned lookup.
  const abort = new AbortController();
  abort.abort();
  let lookups = 0;
  const resolver = async (): Promise<never> => {
    lookups++;
    throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  };
  await assert.rejects(fetchPublic("https://example.org", { signal: abort.signal, resolver }), { code: "timeout" });
  assert.equal(lookups, 0);
  // Aborted while the lookup is pending: the late DNS failure is handled, not left unhandled.
  const pending = new AbortController();
  const slow = () =>
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })), 20),
    );
  const attempt = fetchPublic("https://example.org", { signal: pending.signal, resolver: slow });
  pending.abort();
  await assert.rejects(attempt, { code: "timeout" });
  await new Promise((resolve) => setTimeout(resolve, 40));
});
