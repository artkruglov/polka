// The server's log (apps/server/log.ts): one JSON line per event, errors to
// stderr, secrets cut whatever the caller passes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { log } from "../apps/server/log.ts";

test("an event is one JSON line with its level, time and fields; secrets are cut", (t) => {
  const errors: string[] = [];
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(line));
  t.mock.method(console, "log", (line: string) => lines.push(line));
  log.error({ event: "test.failed", code: "internal", token: "abc", headers: { authorization: "Bearer xyz" } });
  log.info({ event: "test.done", password: "hunter2" });
  assert.equal(errors.length, 1);
  assert.equal(lines.length, 1);
  const error = JSON.parse(errors[0]!);
  assert.equal(error.level, "error");
  assert.equal(error.event, "test.failed");
  assert.equal(error.code, "internal");
  assert.ok(!Number.isNaN(Date.parse(error.time)));
  assert.equal(error.token, "[redacted]");
  assert.equal(error.headers.authorization, "[redacted]");
  assert.equal(JSON.parse(lines[0]!).password, "[redacted]");
  assert.doesNotMatch(errors[0]! + lines[0]!, /abc|xyz|hunter2/);
  assert.equal("pid" in error || "hostname" in error, false);
});
