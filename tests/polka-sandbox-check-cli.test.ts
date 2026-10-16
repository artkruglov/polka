// The sandbox check kit (scripts/polka-sandbox-check.mjs): a probe is
// «blocked» only when it works outside and fails inside for the right
// reason; a broken runner or tool is «not checked», never «blocked».
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error a plain .mjs CLI without types
import { check, exitCode, main, verdict } from "../scripts/polka-sandbox-check.mjs";

let dir = "";
let canary = "";
let allowed = "";
let hide = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "polka-check-"));
  canary = join(dir, "secret", "canary");
  allowed = join(dir, "work", "ok.txt");
  await mkdir(join(dir, "secret"));
  await mkdir(join(dir, "work"));
  await writeFile(canary, "canary-value-123\n");
  await writeFile(allowed, "work-ok\n");
  // A pretend sandbox: hides the secret folder from the command and drops
  // the environment, like env -i + srt would.
  hide = join(dir, "hide.sh");
  await writeFile(
    hide,
    `#!/usr/bin/env bash\nexec env -i PATH="$PATH" bash -c "\${1//${join(dir, "secret").replaceAll("/", "\\/")}/\\/nonexistent}"\n`,
  );
  await chmod(hide, 0o755);
});
after(() => rm(dir, { recursive: true, force: true }));

const options = () => ({ canary: [canary], "allowed-read": allowed, work: join(dir, "work") });

test("the verdict needs a working control and a clean failure inside", () => {
  assert.equal(verdict({ control: true, inside: false }), "blocked");
  assert.equal(verdict({ control: true, inside: true }), "NOT-BLOCKED");
  assert.equal(verdict({ control: false, inside: false }), "not-checked");
  assert.equal(verdict({ control: true, inside: null }), "not-checked");
  assert.equal(verdict({ control: null, inside: true, positive: true }), "ok");
  assert.equal(verdict({ control: null, inside: false, positive: true }), "fails");
});

test("without a sandbox nothing is blocked", async () => {
  const report = await check({ ...options(), runner: "none" });
  const reads = report.results.filter((r: any) => r.id.startsWith("read:") && r.id.endsWith(canary));
  assert.ok(reads.length >= 2);
  for (const r of reads) assert.ok(["NOT-BLOCKED", "not-checked"].includes(r.status), JSON.stringify(r));
  assert.equal(report.results.find((r: any) => r.id === "env").status, "NOT-BLOCKED");
  assert.equal(exitCode(report), 1);
});

test("a sandbox that hides the secret and the environment blocks them", async () => {
  const report = await check({ ...options(), runner: hide });
  assert.equal(report.results.find((r: any) => r.id === `read:cat:${canary}`).status, "blocked");
  assert.equal(report.results.find((r: any) => r.id === `read:bash:${canary}`).status, "blocked");
  assert.equal(report.results.find((r: any) => r.id === "env").status, "blocked");
  assert.equal(report.results.find((r: any) => r.id === "read-allowed").status, "ok");
});

test("a broken runner proves nothing: every «blocked» becomes «not checked»", async () => {
  const report = await check({ ...options(), runner: "false" });
  assert.equal(report.results.find((r: any) => r.id === "runner").status, "fails");
  assert.ok(report.results.every((r: any) => r.status !== "blocked"));
  assert.equal(exitCode(report), 2);
});

test("a tool that does not start inside is «not checked», not «blocked»", async () => {
  // python3 is hidden inside; cat still works.
  const noPython = join(dir, "no-python.sh");
  await writeFile(noPython, `#!/usr/bin/env bash\nexec "${hide}" "\${1//python3/no-such-python3}"\n`);
  await chmod(noPython, 0o755);
  const report = await check({ ...options(), runner: noPython });
  const python = report.results.find((r: any) => r.id === `read:python:${canary}`);
  assert.equal(python.status, "not-checked");
  assert.equal(python.detail, "инструмент не работает в песочнице");
});

test("the CLI prints a table and exits by the worst result", async () => {
  let out = "";
  const code = await main(["--runner", hide, "--canary", canary, "--allowed-read", allowed], {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: () => true },
  });
  assert.match(out, /заблокировано/);
  assert.match(out, /Свидетельство одного прогона/);
  // The pretend sandbox does not stop writes to the home folder.
  assert.match(out, /НЕ ЗАБЛОКИРОВАНО\s+runtime\s+запись вне рабочей папки/);
  assert.equal(code, 1);
  assert.equal(await main([], { stdout: { write: () => true }, stderr: { write: () => true } }), 2);
});
