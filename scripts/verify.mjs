#!/usr/bin/env node
// Everything to check before a push or a deploy, run locally in order. The
// GitHub Actions workflow (.github/workflows/verify.yml) runs the same steps
// through --only, so the licence allowlist and the gitleaks digest live here
// alone. Needs the local infrastructure (npm run infra:up) and .env. Stops at
// the first failing step.
//
//   npm run verify                 all steps
//   npm run verify -- --quick      types, links, build and the default suite only
//   npm run verify -- --print-steps          the step ids, one per line
//   npm run verify -- --only=licenses,secrets  just these steps, in this order
import { spawnSync } from "node:child_process";

const quick = process.argv.includes("--quick");
const only = process.argv
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",")
  .filter(Boolean);
const node = process.execPath;

const schema = () => {
  const result = spawnSync(
    node,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { CURRENT_SCHEMA_VERSION } from "./packages/migrations.ts"; console.log(CURRENT_SCHEMA_VERSION)',
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("Cannot read the schema version");
  return result.stdout.trim();
};

const docker = () => spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

// [id, label, command, args, run only in the full pass]
const steps = [
  ["check", "types and frontend layers", "npm", ["run", "check"]],
  ["links", "Markdown links", "npm", ["run", "check:links"]],
  ["build", "web build", "npm", ["run", "build"]],
  ["test", "default suite", "npm", ["test"]],
  ["live", "live viewer suite", "npm", ["test", "--", "--live"], true],
  [
    "grants",
    "database role grants",
    node,
    () => [
      "--env-file=.env",
      "--import",
      "tsx",
      "scripts/test-runtime-grants-isolated.ts",
      "--confirm-synthetic",
      `--expected-schema=${schema()}`,
    ],
    true,
  ],
  // Licenses of the packages Полка depends on, not Полка's own (AGPL-3.0-only;
  // the root package is private and excluded). Every one listed is compatible
  // with the AGPL-3.0; a new license needs that checked before it is added.
  // Unlicense: robust-predicates (via d3-delaunay), public-domain dedication.
  [
    "licenses",
    "licenses of production dependencies",
    "npx",
    [
      "--yes",
      "license-checker-rseidelsohn@4.4.2",
      "--production",
      "--excludePrivatePackages",
      "--onlyAllow",
      "MIT;MIT-0;ISC;Apache-2.0;BSD-2-Clause;BSD-3-Clause;0BSD;BlueOak-1.0.0;Unlicense",
    ],
    true,
  ],
  [
    "secrets",
    "secrets in history",
    "docker",
    () => [
      "run",
      "--rm",
      "-v",
      `${process.cwd()}:/repo`,
      // zricethezav/gitleaks:v8.24.2
      "zricethezav/gitleaks@sha256:b5918eb91b8d2473cec722f066abb4352e4ffdc4ec9f4283ec143aba9ec9ebc4",
      "git",
      "/repo",
      "--config",
      "/repo/.gitleaks.toml",
      "--redact",
      "--no-banner",
    ],
    true,
  ],
  [
    "image",
    "application image builds",
    "docker",
    ["build", "-q", "-t", "polka:verify", "."],
    true,
  ],
  [
    "backup-image",
    "backup image builds",
    "docker",
    ["build", "-q", "-t", "polka-backup:verify", "deploy/hosted/backup"],
    true,
  ],
];

if (process.argv.includes("--print-steps")) {
  for (const [id, label, , , full] of steps)
    console.log(`${id}\t${label}${full ? " (full pass only)" : ""}`);
  process.exit(0);
}
const unknown = only?.filter((id) => !steps.some((step) => step[0] === id));
if (unknown?.length) {
  console.error(`Unknown step: ${unknown.join(", ")} (see --print-steps)`);
  process.exit(2);
}
const selected = only
  ? only.map((id) => steps.find((step) => step[0] === id))
  : steps.filter((step) => !(step[4] && quick));

const started = Date.now();
for (const [, label, command, args] of selected) {
  // A step asked for by name never skips silently.
  if (command === "docker" && !only && !docker()) {
    console.log(`skip ${label}: Docker is not running`);
    continue;
  }
  console.log(`\n== ${label}`);
  const argv = typeof args === "function" ? args() : args;
  const result = spawnSync(command, argv, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nFAILED: ${label}`);
    process.exit(result.status ?? 1);
  }
}
console.log(`\nAll checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
