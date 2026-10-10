// The shared helpers in packages/contracts that replaced per-module copies.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { escapeHtml } from "../packages/contracts/html.ts";
import { isUuid, UUID_RE } from "../packages/contracts/uuid.ts";

test("escapeHtml escapes & < > \" ' and nothing else", () => {
  assert.equal(
    escapeHtml(`<a href="x" title='y'>&amp;</a>`),
    "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;",
  );
  assert.equal(escapeHtml("Полка — ok"), "Полка — ok");
});

test("UUID_RE takes a UUID of any version in either case, and nothing around it", () => {
  const id = randomUUID();
  assert.ok(UUID_RE.test(id));
  assert.ok(isUuid(id.toUpperCase()));
  assert.ok(isUuid("00000000-0000-0000-0000-000000000000"));
  for (const bad of [`${id} `, `x${id}`, id.slice(1), id.replaceAll("-", ""), 42, null])
    assert.equal(isUuid(bad), false);
});
