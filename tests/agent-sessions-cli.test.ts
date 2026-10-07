import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  commandShape,
  createRedactor,
  prepareSession,
} from "../scripts/polka-sessions.mjs";
import { FAKE, claudeSession, codexSession } from "./agent-sessions-fixtures.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "polka-sessions-cli-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = Buffer.from("test-fingerprint-key");

test("a Claude Code session: facts, secrets report and a redacted transcript without thinking", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const path = join(dir, `${id}.jsonl`);
  await writeFile(path, claudeSession(id));
  const { body, transcriptGz, index } = await prepareSession({ source: "claude-code", path, id }, KEY);
  assert.equal(body.externalId, id);
  assert.equal(body.project.label, "demo-app");
  assert.equal(body.permissionMode, "bypassPermissions");
  assert.equal(body.toolCallCount, 5);
  assert.deepEqual(body.toolCalls.map((c: { kind: string }) => c.kind), ["shell", "shell", "shell", "web", "mcp"]);
  assert.equal(body.toolCalls[1].template, "git push --force origin");
  assert.equal(body.toolCalls[1].status, "error");
  assert.equal(body.toolCalls[2].pipeToShell, true);
  assert.deepEqual(body.toolCalls[0].hosts, ["db.example.com"]);
  assert.equal(body.tokens.output, 50);
  assert.deepEqual(body.links.prs, ["https://github.com/example/demo/pull/7"]);
  assert.deepEqual(body.links.works, ["00000000-0000-4000-8000-000000000000"]);
  assert.deepEqual(index.unknownRecordTypes, { "some-new-record": 1 });
  // The token went into a web request: sent out.
  assert.equal(body.secretsStatus, "sent_out");
  const github = body.secrets.find((s: { type: string }) => s.type === "github-token");
  assert.ok(github?.toNetwork && github.seenByModel);
  assert.ok(body.secrets.some((s: { type: string; toCommand: boolean }) => s.type === "url-password" && s.toCommand));
  // Nothing secret leaves the machine: neither in the index nor in the transcript.
  const transcript = gunzipSync(transcriptGz).toString();
  const everything = JSON.stringify(body) + transcript;
  for (const value of Object.values(FAKE)) assert.ok(!everything.includes(value), `leaked ${value.slice(0, 4)}…`);
  assert.match(transcript, /\[REDACTED:github-token:[0-9a-f]{12}\]/);
  assert.ok(!transcript.includes("Private reasoning"));
  assert.match(transcript, /\[image\]/);
  const [header, ...events] = transcript.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(header.schema, "polka-session-transcript/1");
  assert.equal(header.thinking, false);
  assert.deepEqual([...new Set(events.map((e: { type: string }) => e.type))], ["prompt", "assistant", "tool_call", "tool_result"]);
  assert.equal(body.transcript.bytes, transcriptGz.length);
  // With --thinking the reasoning is kept, redacted like the rest.
  const withThinking = await prepareSession({ source: "claude-code", path, id }, KEY, { thinking: true });
  assert.match(gunzipSync(withThinking.transcriptGz).toString(), /Private reasoning/);
});

test("a Codex rollout: model tokens, permission mode, shell calls", async () => {
  const id = "019f0000-0000-7000-8000-000000000001";
  const path = join(dir, `rollout-2026-10-07T11-00-00-${id}.jsonl`);
  await writeFile(path, codexSession(id));
  const { body, transcriptGz } = await prepareSession({ source: "codex", path, id }, KEY);
  assert.equal(body.source, "codex");
  assert.equal(body.externalId, id);
  assert.equal(body.permissionMode, "never/danger-full-access");
  assert.equal(body.project.remote, "https://git.example.com/api.git");
  assert.deepEqual(body.models["gpt-5.5"], { input: 300, output: 40, cacheRead: 200, cacheWrite: 0 });
  assert.equal(body.tokens.reasoning, 7);
  assert.equal(body.toolCalls[0].argv0, "ls");
  assert.equal(body.toolCalls[0].exitCode, 0);
  assert.equal(body.secretsStatus, "clean");
  assert.ok(!gunzipSync(transcriptGz).toString().includes("Thinking about files"));
});

test("the redactor replaces the captured value, not an equal user name", () => {
  const redactor = createRedactor(KEY);
  const same = redactor.redact("postgres://world:world@localhost/db", "x");
  assert.match(same, /^postgres:\/\/world:\[REDACTED:url-password:[0-9a-f]{12}\]@localhost\/db$/);
  assert.match(redactor.redact(`token=${FAKE.bare}`, "x"), /^token=\[REDACTED:assignment:/);
  assert.match(redactor.redact(`OD_SECRET=${FAKE.hexSecret}`, "x"), /^OD_SECRET=\[REDACTED:assignment:/);
  // Code and placeholders stay.
  for (const text of ["password: string", "token: null", "API_KEY=${API_KEY}", "const secret = loadSecret()", "commit " + "0123456789abcdef".repeat(2) + "01234567"])
    assert.equal(redactor.redact(text, "x"), text);
  assert.deepEqual(commandShape("FOO=1 rm -rf /tmp/x && echo ok"), { argv0: "rm", template: "rm -rf <arg>" });
});
