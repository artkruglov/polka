/**
 * Acceptance with a real MCP client (#47): Claude Code or Codex, holding only the
 * context, read and manage permissions, renames a work, moves it into a folder,
 * trashes it, finds it in the trash and restores it — nothing done in the web app.
 * The server then checks the result and the journal.
 *
 *   npm run dev                                   # in another terminal
 *   npx tsx --env-file=.env scripts/agent-manage-acceptance.ts [--agent claude|codex]
 *
 * --model <id> passes a model to the CLI. Local installations only: it creates a throwaway account and a 30-minute token,
 * revokes the token at the end and prints a report. See docs/dev/AGENT_MANAGE_ACCEPTANCE.md.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount } from "../apps/server/auth.ts";
import { captureFromAgent } from "../apps/server/agent-capture.ts";
import { createFolderFromAgent } from "../apps/server/agent-folders.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { authenticateServiceToken, MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { prepareCapture } from "./prepare-capture.ts";

const option = (name: string) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const agent = option("--agent") ?? "claude";
// The CLI's own default otherwise; Codex on a ChatGPT account refuses some models.
const model = option("--model");
if (agent !== "claude" && agent !== "codex") throw Error("--agent claude|codex");
if (!["127.0.0.1", "localhost"].includes(new URL(config.APP_ORIGIN).hostname))
  throw Error("Local installations only: APP_ORIGIN must be 127.0.0.1 or localhost");
const health = await fetch(new URL("/api/health", config.APP_ORIGIN)).catch(() => null);
if (!health?.ok) throw Error(`No Polka at ${config.APP_ORIGIN}: start it with npm run dev`);

const TITLE = "Отчёт для приёмки";
const NEW_TITLE = "Отчёт для приёмки — проверен";
const FOLDER = "Принято";
const DECOY = "Не трогать";

const suffix = randomBytes(4).toString("hex");
const person = await createAccount(`manage-accept-${suffix}`, randomBytes(24).toString("hex"));
const connectionId = randomUUID();
const token = randomBytes(32).toString("base64url");
await db.query(
  `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
   VALUES($1,$2,$3,$4,'manage acceptance (#47)',$5,$6,now()+interval '30 minutes')`,
  [connectionId, person.tenant, person.id, sha256(token), ["context", "read", "manage"], MCP_AUDIENCE],
);
// The seed goes through a separate capture token, so the agent's own one has no capture right.
const seedToken = randomBytes(32).toString("base64url");
await db.query(
  `INSERT INTO agent_connections(id,tenant_id,account_id,token_hash,name,scopes,audience,expires_at)
   VALUES($1,$2,$3,$4,'manage acceptance seed',$5,$6,now()+interval '5 minutes')`,
  [randomUUID(), person.tenant, person.id, sha256(seedToken), ["capture", "manage"], MCP_AUDIENCE],
);
const seeder = await authenticateServiceToken(seedToken, MCP_AUDIENCE);
const bundle = await prepareCapture("tests/fixtures/bundle-corpus/team-report", "index.html", [
  "index.html",
  "assets/report.css",
  "assets/report.js",
  "assets/mark.svg",
]);
const work = await captureFromAgent(seeder, { ...bundle, key: randomUUID(), title: TITLE }, "capture");
const decoy = await captureFromAgent(seeder, { ...bundle, key: randomUUID(), title: DECOY }, "capture");
const folder = (await createFolderFromAgent(seeder, { key: randomUUID(), name: FOLDER })).applied;
await db.query("UPDATE agent_connections SET revoked_at=now() WHERE token_hash=$1", [sha256(seedToken)]);

const prompt = `На моей Полке (MCP-сервер polka) есть работа «${TITLE}». Сделай с ней по очереди:
1. Переименуй в «${NEW_TITLE}» и перенеси в папку «${FOLDER}».
2. Убери её в корзину.
3. Убедись, что она есть в корзине.
4. Верни её из корзины.
5. Покажи её название, папку и состояние.
Пользуйся только инструментами polka, другие работы не трогай, ссылок не выдавай. Если шаг не удался, остановись и скажи, что пошло не так.`;

const dir = await mkdtemp(join(tmpdir(), "polka-manage-"));
let output = "";
let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
const started = Date.now();
try {
  let command: string;
  let args: string[];
  const env: NodeJS.ProcessEnv = { ...process.env, POLKA_MCP_TOKEN: token };
  if (agent === "claude") {
    const mcpConfig = join(dir, "mcp.json");
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: { polka: { type: "http", url: MCP_AUDIENCE, headers: { Authorization: `Bearer ${token}` } } },
      }),
      { mode: 0o600 },
    );
    command = "claude";
    args = ["-p", prompt, "--mcp-config", mcpConfig, "--strict-mcp-config", "--allowedTools", "mcp__polka"];
    args.push("--output-format", "stream-json", "--verbose", "--no-session-persistence");
    if (model) args.push("--model", model);
  } else {
    command = "codex";
    args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json"];
    args.push("-c", `mcp_servers.polka.url="${MCP_AUDIENCE}"`);
    args.push(
      "-c",
      'mcp_servers.polka.bearer_token_env_var="POLKA_MCP_TOKEN"',
      "-c",
      "mcp_servers.polka.required=true",
    );
    // Codex asks a person before a tool marked destructive; exec has nobody to ask. These are
    // the approvals a person would give in the interactive CLI, nothing wider.
    for (const tool of ["polka_trash", "polka_restore"])
      args.push("-c", `mcp_servers.polka.tools.${tool}.approval_mode="approve"`);
    if (model) args.push("--model", model);
    args.push(prompt);
  }
  const child = spawn(command, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const timer = setTimeout(() => child.kill("SIGTERM"), 5 * 60_000);
  exit = await new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, signal: "spawn-error" }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
} finally {
  await db.query("UPDATE agent_connections SET revoked_at=now() WHERE id=$1", [connectionId]);
  await rm(dir, { recursive: true, force: true });
}
output = output.split(token).join("[token]");

// Both CLIs print one JSON event per line.
const events = output.split("\n").flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
// The polka tools the agent called, in order, and how many failed.
const calls: string[] = [];
let failed = 0;
for (const event of events) {
  for (const part of event.type === "assistant" ? (event.message?.content ?? []) : [])
    if (part.type === "tool_use" && String(part.name).startsWith("mcp__polka__"))
      calls.push(String(part.name).slice("mcp__polka__".length));
  for (const part of event.type === "user" ? (event.message?.content ?? []) : [])
    if (part.type === "tool_result" && part.is_error) failed++;
  if (event.type === "item.completed" && event.item?.type === "mcp_tool_call" && event.item.server === "polka") {
    calls.push(String(event.item.tool));
    if (event.item.status !== "completed" || event.item.error) failed++;
  }
}
// The agent's last words: Claude's "result" event, Codex's last agent message.
const answer = String(
  events.findLast((event) => event.type === "result")?.result ??
    events.findLast((event) => event.item?.type === "agent_message")?.item?.text ??
    "",
);

const read = async (artifactId: string) => {
  const { rows } = await db.query("SELECT title,folder_id,trashed_at FROM artifacts WHERE id=$1 AND tenant_id=$2", [
    artifactId,
    person.tenant,
  ]);
  return rows[0];
};
const after = await read(work.artifactId);
const untouched = await read(decoy.artifactId);
const { rows: journal } = await db.query(
  `SELECT action FROM audit_outbox WHERE tenant_id=$1 AND target_id=$2 AND actor_type='agent' AND connection_id=$3
   ORDER BY id`,
  [person.tenant, work.artifactId, connectionId],
);
const actions = journal.map((row) => row.action as string);
const checks = {
  renamed: after.title === NEW_TITLE,
  inFolder: after.folder_id === folder.id,
  restored: after.trashed_at === null,
  trashedThenRestored:
    actions.indexOf("artifact.trashed") >= 0 &&
    actions.lastIndexOf("artifact.restored") > actions.indexOf("artifact.trashed"),
  decoyUntouched: untouched.title === DECOY && untouched.folder_id === null && untouched.trashed_at === null,
};
const passed = Object.values(checks).every(Boolean);
console.log(
  JSON.stringify(
    {
      agent,
      model: model ?? "CLI default",
      passed,
      checks,
      exit,
      seconds: Math.round((Date.now() - started) / 1000),
      toolCalls: calls,
      toolErrors: failed,
      ...(calls.length ? {} : { cliErrors: events.filter((event) => /error|failed/.test(event.type ?? "")) }),
      journal: actions,
      answer: answer.slice(0, 1500),
      account: person.name,
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
await db.end();
s3.destroy();
process.exit(passed ? 0 : 1);
