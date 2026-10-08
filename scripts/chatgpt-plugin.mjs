#!/usr/bin/env node
// Build the ZIP that ChatGPT's plugin submission takes
// (developers.openai.com/apps-sdk/deploy/submission): the Codex manifest,
// .mcp.json (one remote server, https://polochka.app/mcp), skills/ and the
// listing icons. No hooks — a package with lifecycle hooks is refused, so the
// agent-sessions hook of the Claude Code/Codex plugin stays out.
//
//   node scripts/chatgpt-plugin.mjs dist/polka-chatgpt.zip
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/chatgpt-plugin.mjs <file.zip>");
  process.exit(2);
}

// The submission form's limits, checked here so a refusal comes before the upload.
const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"));
const ui = manifest.interface ?? {};
const problems = [];
const within = (field, max) => {
  if (typeof ui[field] !== "string" || !ui[field].trim()) problems.push(`interface.${field} is missing`);
  else if (ui[field].length > max) problems.push(`interface.${field} is ${ui[field].length} characters, at most ${max}`);
};
within("displayName", 30);
within("shortDescription", 30);
within("longDescription", 4000);
within("developerName", 80);
for (const field of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"])
  if (!String(ui[field] ?? "").startsWith("https://")) problems.push(`interface.${field} is not an https URL`);
const prompts = ui.defaultPrompt ?? [];
if (prompts.length > 3 || prompts.some((p) => p.length > 128)) problems.push("interface.defaultPrompt: at most 3 prompts of 128 characters");
for (const field of ["logo", "composerIcon"]) {
  const path = ui[field];
  if (!path?.startsWith("./") || !existsSync(join(root, path))) problems.push(`interface.${field} is not a file under ./`);
  else if (statSync(join(root, path)).size > 5 * 1024 * 1024) problems.push(`interface.${field} is over 5 MiB`);
}
const servers = Object.values(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers ?? {});
if (servers.length !== 1 || !String(servers[0].url ?? "").startsWith("https://")) problems.push(".mcp.json must declare one remote https server");
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "polka-chatgpt-"));
try {
  for (const path of [".codex-plugin/plugin.json", ".mcp.json", "skills", "assets", "LICENSE"]) {
    mkdirSync(dirname(join(stage, path)), { recursive: true });
    cpSync(join(root, path), join(stage, path), { recursive: true });
  }
  const zip = resolve(target);
  mkdirSync(dirname(zip), { recursive: true });
  rmSync(zip, { force: true });
  execFileSync("zip", ["-qrX", zip, "."], { cwd: stage });
  console.log(`wrote ${zip} (polka ${manifest.version})`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
