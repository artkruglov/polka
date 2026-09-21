import assert from "node:assert/strict";
import test from "node:test";
import {
  createMaintenanceLogFilter,
  type SafeMaintenanceLog,
} from "../scripts/maintenance-log-filter.ts";

test("only allowlisted fields survive chunked child output", () => {
  const output: SafeMaintenanceLog[] = [];
  const filter = createMaintenanceLogFilter((e) => output.push(e));
  const input = Buffer.from(
    "provider error secret\n" +
      JSON.stringify({
        event: "maintenance.completed",
        durationMs: 12,
        expiredUploadsReconciled: 3,
        password: "secret",
        url: "https://private",
      }) +
      "\n",
  );
  for (let i = 0; i < input.length; i += 7)
    filter.push(input.subarray(i, i + 7));
  filter.end();
  assert.deepEqual(output, [
    {
      event: "maintenance.completed",
      durationMs: 12,
      expiredUploadsReconciled: 3,
    },
  ]);
});

test("reject malformed counts/reasons and recover after oversized lines", () => {
  const output: SafeMaintenanceLog[] = [];
  const filter = createMaintenanceLogFilter((e) => output.push(e));
  for (const row of [
    { event: "maintenance.completed", durationMs: -1 },
    { event: "maintenance.failed", reason: "password" },
    { event: "maintenance.completed", emailChallengesRemoved: 1.5 },
  ])
    filter.push(Buffer.from(JSON.stringify(row) + "\n"));
  filter.push(Buffer.alloc(100000, 65));
  filter.push(
    Buffer.from('\n{"event":"maintenance.skipped","reason":"busy"}\n'),
  );
  filter.end();
  assert.deepEqual(output, [{ event: "maintenance.skipped", reason: "busy" }]);
});

test("caps total forwarded bytes and contains sink failure", () => {
  let total = 0,
    count = 0;
  const filter = createMaintenanceLogFilter((e) => {
    total += Buffer.byteLength(JSON.stringify(e)) + 1;
    count++;
    throw new Error("sink");
  });
  const line = Buffer.from('{"event":"maintenance.started"}\n');
  for (let i = 0; i < 10000; i++) filter.push(line);
  filter.end();
  assert.ok(count > 0);
  assert.ok(count < 10000);
  assert.ok(total <= 65536);
});
