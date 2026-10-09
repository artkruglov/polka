import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { commandShape, createRedactor, main, prepareSession } from "../scripts/polka-sessions.mjs";
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
  assert.deepEqual(
    body.toolCalls.map((c: { kind: string }) => c.kind),
    ["shell", "shell", "shell", "web", "mcp"],
  );
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
  const [header, ...events] = transcript
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(header.schema, "polka-session-transcript/1");
  assert.equal(header.thinking, false);
  assert.deepEqual(
    [...new Set(events.map((e: { type: string }) => e.type))],
    ["prompt", "assistant", "tool_call", "tool_result"],
  );
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
  // A bot token in a Bot API address, where no word boundary precedes it.
  const bot = "7301" + "123456" + ":AA" + "x".repeat(33);
  assert.match(
    redactor.redact(`https://api.telegram.org/bot${bot}/sendMessage`, "x"),
    /^https:\/\/api\.telegram\.org\/bot\[REDACTED:telegram-bot-token:[0-9a-f]{12}\]\/sendMessage$/,
  );
  assert.match(redactor.redact(`TG ${bot}`, "x"), /^TG \[REDACTED:telegram-bot-token:/);
  // Code and placeholders stay.
  for (const text of [
    "password: string",
    "token: null",
    "API_KEY=${API_KEY}",
    "const secret = loadSecret()",
    "commit " + "0123456789abcdef".repeat(2) + "01234567",
  ])
    assert.equal(redactor.redact(text, "x"), text);
  assert.deepEqual(commandShape("FOO=1 rm -rf /tmp/x && echo ok"), { argv0: "rm", template: "rm -rf <arg>" });
  // The setup steps of a chain are not the command.
  assert.deepEqual(commandShape('cd "/a b/c"; npm run -s check 2>&1 | tail'), {
    argv0: "npm",
    template: "npm run -s check",
  });
  assert.deepEqual(commandShape("export A=1 && source .env && psql -c 'select 1'"), {
    argv0: "psql",
    template: "psql -c <arg>",
  });
  assert.deepEqual(commandShape("cd /tmp"), { argv0: "cd", template: "cd <arg>" });
});

// ---------------------------------------------------------------------------
// The hook and the scheduled sync against a stand-in server: which sessions
// arrive after /clear, a closed terminal, days with the machine off.

const SCRIPT = fileURLToPath(new URL("../scripts/polka-sessions.mjs", import.meta.url));
const TOKEN = "t".repeat(43);

/** Полка's session API, as far as the CLI needs it; sessions named in `refuse` get 413. */
async function standIn({ keyDelayMs = 0 } = {}) {
  const received: string[] = [];
  const refuse = new Set<string>();
  let keyRequests = 0;
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const server = createServer(async (req, res) => {
    const reply = (status: number, payload: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    if (req.method === "GET" && req.url === "/api/v1/sessions/key") {
      keyRequests++;
      await new Promise((r) => setTimeout(r, keyDelayMs));
      return reply(200, { key: "00".repeat(32), scope: "shelf", notice: null });
    }
    if (req.method === "POST" && req.url === "/api/v1/sessions") {
      const { externalId } = JSON.parse(gunzipSync(await body(req)).toString());
      if (refuse.has(externalId)) return reply(413, { code: "quota", message: "Too big." });
      received.push(externalId);
      return reply(200, { id: randomUUID(), transcriptNeeded: false });
    }
    reply(404, { code: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    received,
    refuse,
    keyRequests: () => keyRequests,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** A home of its own with Claude Code's folder in it; HOME and CLAUDE_CONFIG_DIR point there meanwhile. */
async function inHome(
  run: (home: string, session: (id: string, ageDays?: number) => Promise<string>) => Promise<void>,
) {
  const home = await mkdtemp(join(dir, "home-"));
  const projects = join(home, ".claude", "projects", "-work-demo-app");
  await mkdir(projects, { recursive: true });
  const was = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  try {
    await run(home, async (id, ageDays = 0) => {
      const path = join(projects, `${id}.jsonl`);
      await writeFile(path, claudeSession(id));
      const at = new Date(Date.now() - ageDays * 86_400_000);
      await utimes(path, at, at);
      return path;
    });
  } finally {
    for (const [name, value] of Object.entries(was))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

async function until(what: string, ok: () => boolean | Promise<boolean>) {
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50)))
    if (await ok()) return;
  assert.fail(`timed out waiting for ${what}`);
}

const said = (out: string[]) => ({
  stdout: { write: (text: string) => out.push(text) },
  stderr: { write: (text: string) => out.push(text) },
});
const stateOf = async (home: string) =>
  JSON.parse(await readFile(join(home, ".polka", "sessions-state.json"), "utf8").catch(() => "{}"));

test("/clear ends one session and starts another: the hook sends both, the scheduled sync neither again", async () => {
  const server = await standIn();
  try {
    await inHome(async (home, session) => {
      const env = { HOME: home, POLKA_SESSIONS: "on", POLKA_TOKEN: TOKEN, POLKA_ENDPOINT: server.endpoint };
      const end = (reason: string, path: string) =>
        main(["hook"], {
          env,
          ...said([]),
          stdin: async () => JSON.stringify({ hook_event_name: "SessionEnd", reason, transcript_path: path }),
        });
      const [cleared, rest] = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"];
      // SessionEnd with reason "clear" for the conversation so far; what follows is a new id and file.
      assert.equal(await end("clear", await session(cleared)), 0);
      await until("the first upload", async () => !!(await stateOf(home))[`claude-code:${cleared}`]);
      assert.equal(await end("prompt_input_exit", await session(rest)), 0);
      await until("the second upload", async () => !!(await stateOf(home))[`claude-code:${rest}`]);
      assert.deepEqual(server.received, [cleared, rest]);
      // /clear before the first prompt: Claude Code wrote no file, there is nothing to send.
      assert.equal(await end("clear", join(home, ".claude", "projects", "-work-demo-app", `${randomUUID()}.jsonl`)), 0);
      assert.match(
        await readFile(join(home, ".polka", "sessions-hook.log"), "utf8"),
        /clear [0-9a-f-]{36}\.jsonl \(no file: nothing to send\)\n/,
      );
      // The hourly sync knows what the hook sent.
      const out: string[] = [];
      assert.equal(await main(["sync", "--since", "2d"], { env, ...said(out) }), 0, out.join(""));
      assert.match(out.join(""), /Sent 0, unchanged 2\.\n$/);
      assert.equal(server.received.length, 2);
    });
  } finally {
    await server.close();
  }
});

test("a closed terminal may run no SessionEnd: the scheduled sync finds the session, even after days off", async () => {
  const server = await standIn();
  try {
    await inHome(async (home, session) => {
      const env = { HOME: home, POLKA_TOKEN: TOKEN, POLKA_ENDPOINT: server.endpoint };
      const id = "bbbbbbbb-0000-4000-8000-000000000001";
      // Closed on Friday, the laptop opened on Monday: older than --since 2d,
      // newer than the last sync that went through.
      await session(id, 3);
      await mkdir(join(home, ".polka"), { recursive: true });
      await writeFile(
        join(home, ".polka", "sessions-state.json"),
        JSON.stringify({ lastSyncAt: Date.now() - 4 * 86_400_000 }),
      );
      const out: string[] = [];
      assert.equal(await main(["sync", "--since", "2d"], { env, ...said(out) }), 0, out.join(""));
      assert.match(out.join(""), /Sent 1, unchanged 0\.\n$/);
      assert.deepEqual(server.received, [id]);
      const state = await stateOf(home);
      assert.ok(state.lastSyncAt > Date.now() - 60_000);
      assert.ok(state[`claude-code:${id}`]);
    });
  } finally {
    await server.close();
  }
});

test(
  "closing the terminal while the hook's upload runs does not stop the upload",
  { skip: process.platform === "win32" },
  async () => {
    const server = await standIn({ keyDelayMs: 500 });
    try {
      await inHome(async (home, session) => {
        const path = await session("cccccccc-0000-4000-8000-000000000001");
        const input = join(home, "hook-input.json");
        await writeFile(
          input,
          JSON.stringify({ hook_event_name: "SessionEnd", reason: "other", transcript_path: path }),
        );
        // The terminal's process group: a shell that runs the hook and stays, as Claude Code would.
        const env = {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          POLKA_SESSIONS: "on",
          POLKA_TOKEN: TOKEN,
          POLKA_ENDPOINT: server.endpoint,
        };
        const terminal = spawn("sh", ["-c", `"${process.execPath}" "${SCRIPT}" hook < "${input}"; sleep 30`], {
          detached: true,
          stdio: "ignore",
          env,
        });
        const closed = new Promise((r) => terminal.once("exit", (_code, signal) => r(signal)));
        await until("the upload to start", () => server.keyRequests() === 1);
        process.kill(-terminal.pid!, "SIGHUP");
        assert.equal(await closed, "SIGHUP");
        assert.equal(server.received.length, 0, "the upload was still waiting for the key");
        await until("the upload to arrive", () => server.received.length === 1);
      });
    } finally {
      await server.close();
    }
  },
);

test("a session the server refuses does not hold back the others and is tried again", async () => {
  const server = await standIn();
  try {
    await inHome(async (home, session) => {
      const env = { HOME: home, POLKA_TOKEN: TOKEN, POLKA_ENDPOINT: server.endpoint };
      const [big, fine] = ["dddddddd-0000-4000-8000-000000000001", "dddddddd-0000-4000-8000-000000000002"];
      await session(big);
      await session(fine, 1);
      server.refuse.add(big);
      const out: string[] = [];
      assert.equal(await main(["sync"], { env, ...said(out) }), 1);
      assert.match(out.join(""), new RegExp(`not sent claude-code:${big}: Полка answered 413`));
      assert.match(out.join(""), /Sent 1, unchanged 0, refused 1\.\n$/);
      assert.deepEqual(server.received, [fine]);
      // The run did not go through: the next one reaches back as far.
      assert.equal((await stateOf(home)).lastSyncAt, undefined);
      server.refuse.clear();
      out.length = 0;
      assert.equal(await main(["sync"], { env, ...said(out) }), 0, out.join(""));
      assert.match(out.join(""), /Sent 1, unchanged 1\.\n$/);
      assert.deepEqual(server.received, [fine, big]);
    });
  } finally {
    await server.close();
  }
});
