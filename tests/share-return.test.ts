// Signing in from a shared link returns to it without the token ever riding
// in a query string (apps/web/src/shared/lib/share-return.ts).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const store = new Map<string, string>();
(globalThis as any).sessionStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
const {
  SHARE_RETURN_PATH,
  rememberShareForSignIn,
  signInFromShare,
  takeShareAfterSignIn,
} = await import("../apps/web/src/shared/lib/share-return.ts");
const { authReturnTo, safeNext } = await import(
  "../apps/web/src/shared/lib/safe-next.ts"
);

const token = "A".repeat(20) + "b_-".repeat(7) + "Z".repeat(2);
beforeEach(() => store.clear());

test("the sign-in page gets /s, never the token", () => {
  assert.equal(token.length, 43);
  const href = signInFromShare(token);
  assert.equal(href, "/signup?next=%2Fs");
  assert.ok(!href.includes(token));
  assert.equal(safeNext(new URLSearchParams(href.split("?")[1]).get("next")), SHARE_RETURN_PATH);
  // The generic return path of a share page never carries the fragment either.
  assert.equal(authReturnTo({ pathname: "/s", search: "", hash: `#${token}` }), "/start");
});

test("the token comes back once, fresh and well-formed only", () => {
  assert.equal(rememberShareForSignIn(token), true);
  assert.equal(takeShareAfterSignIn(), token);
  assert.equal(takeShareAfterSignIn(), null);
  assert.equal(rememberShareForSignIn("not a token"), false);
  assert.equal(takeShareAfterSignIn(), null);
  rememberShareForSignIn(token);
  assert.equal(takeShareAfterSignIn(Date.now() + 31 * 60 * 1000), null);
  store.set("polka.share-return", "{broken");
  assert.equal(takeShareAfterSignIn(), null);
  store.set("polka.share-return", JSON.stringify({ token: "x", at: Date.now() }));
  assert.equal(takeShareAfterSignIn(), null);
});
