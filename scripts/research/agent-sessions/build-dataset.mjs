// Stage 0 of the agent sessions plan: every local Claude Code and Codex
// session of this machine into the session index (redacted), written as
// NDJSON tables for the storage experiment. Content is not kept: only facts,
// tool-call metadata and the secrets report.
//   node build-dataset.mjs <out-dir> [--shards 4]
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRedactor } from "./redact.mjs";
import { parseClaude, parseCodex, secretsReport } from "./normalize.mjs";

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const [out, ...rest] = process.argv.slice(2);
const shardArg = rest.indexOf("--shard");
if (shardArg >= 0) {
  // A worker: its share of the files, with the run's fingerprint key.
  const [shard, of] = rest[shardArg + 1].split("/").map(Number);
  const key = readFileSync(join(out, "fingerprint.key"));
  const files = JSON.parse(readFileSync(join(out, "files.json"), "utf8")).filter((_, i) => i % of === shard);
  const sessions = createWriteStream(join(out, `sessions.${shard}.ndjson`));
  const calls = createWriteStream(join(out, `tool_calls.${shard}.ndjson`));
  const secrets = createWriteStream(join(out, `findings.${shard}.ndjson`));
  const samples = createWriteStream(join(out, `samples.${shard}.ndjson`));
  for (const { path, source } of files) {
    const redactor = createRedactor(key);
    const started = performance.now();
    let index;
    try {
      index = source === "codex" ? await parseCodex(path, redactor) : await parseClaude(path, redactor);
    } catch (error) {
      sessions.write(JSON.stringify({ file: path, failed: String(error?.message ?? error).slice(0, 200) }) + "\n");
      continue;
    }
    const report = secretsReport(redactor.findings());
    const sid = `${source}:${index.sessionId ?? index.file}:${index.file}`;
    const { toolCalls, ...facts } = index;
    sessions.write(JSON.stringify({ sid, ...facts, toolCallCount: toolCalls.length, secretsStatus: report.status, findings: report.items.length, parseMs: Math.round(performance.now() - started) }) + "\n");
    for (const call of toolCalls) calls.write(JSON.stringify({ sid, ...call }) + "\n");
    for (const item of report.items) secrets.write(JSON.stringify({ sid, ...item }) + "\n");
    for (const sample of redactor.samples()) samples.write(JSON.stringify(sample) + "\n");
  }
  await Promise.all([sessions, calls, secrets, samples].map((s) => new Promise((r) => s.end(r))));
} else {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "fingerprint.key"), randomBytes(32), { mode: 0o600 });
  const files = [
    ...walk(join(homedir(), ".claude/projects")).map((path) => ({ path, source: "claude-code" })),
    ...walk(join(homedir(), ".codex/sessions")).map((path) => ({ path, source: "codex" })),
  ];
  writeFileSync(join(out, "files.json"), JSON.stringify(files));
  const shards = Number(rest[rest.indexOf("--shards") + 1]) || 4;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: shards }, (_, shard) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), out, "--shard", `${shard}/${shards}`], { stdio: "inherit" });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`shard ${shard} exited ${code}`))));
      }),
    ),
  );
  console.log(JSON.stringify({ files: files.length, shards, seconds: Math.round((Date.now() - started) / 1000) }));
}
