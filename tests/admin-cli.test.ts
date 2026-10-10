// The operator's commands (scripts/admin.ts): every command names a script
// that exists, the npm scripts it replaced are gone, and a command runs its
// script with the arguments that follow.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { COMMANDS, usage } from "../scripts/admin.ts";

const root = new URL("../", import.meta.url);
const admin = (...args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/admin.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    input: "",
    env: process.env,
  });

test("every command names an existing script and is listed in the usage", () => {
  const text = usage();
  for (const [group, commands] of Object.entries(COMMANDS))
    for (const [name, command] of Object.entries(commands)) {
      assert.ok(existsSync(new URL(`scripts/${command.script}`, root)), `${group} ${name}: ${command.script}`);
      assert.match(text, new RegExp(`\\n  ${name} `), `${group} ${name} is not in the usage`);
    }
  const scripts = Object.keys(JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts);
  assert.ok(scripts.includes("admin"));
  assert.deepEqual(
    scripts.filter((name) => /^(moderation|account|covers|search|company|feed|shelf|editorial):|^metrics$/.test(name)),
    [],
  );
});

test("no command prints the usage; an unknown one is refused", () => {
  const listed = admin();
  assert.equal(listed.status, 0);
  assert.match(listed.stderr, /^Usage: npm run admin -- <group> <command>/);
  const unknown = admin("moderation", "nope");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command: moderation nope/);
});

test("a command runs its script as if started directly", () => {
  // account create without a login refuses with its own message.
  const run = admin("account", "create");
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /npm run admin -- account create \S+ --generate/);
});
