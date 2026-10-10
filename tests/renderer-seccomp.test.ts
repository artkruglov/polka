import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type Rule = { names: string[]; action: string; includes?: object; excludes?: object; args?: unknown[] };

// deploy/renderer/seccomp-chromium.json is Docker's default profile plus what
// Chromium's sandbox needs (deploy/renderer/README.md): only those calls are
// opened, and both compose files run the renderer with it.
test("the renderer's seccomp profile opens only Chromium's sandbox calls", () => {
  const profile: { defaultAction: string; syscalls: Rule[] } = JSON.parse(
    readFileSync("deploy/renderer/seccomp-chromium.json", "utf8"),
  );
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  const unconditional = profile.syscalls.filter(
    (rule: Rule) =>
      rule.action === "SCMP_ACT_ALLOW" &&
      !rule.includes &&
      !rule.excludes &&
      !rule.args?.length &&
      rule.names.some((name: string) => ["clone", "unshare", "setns", "chroot", "mount", "bpf"].includes(name)),
  );
  assert.deepEqual(unconditional.flatMap((rule: Rule) => rule.names).sort(), ["chroot", "clone", "setns", "unshare"]);
  for (const file of ["deploy/renderer/compose.yml", "deploy/hosted/compose.yml"]) {
    assert.match(readFileSync(file, "utf8"), /seccomp=\S*seccomp-chromium\.json/, file);
  }
});
