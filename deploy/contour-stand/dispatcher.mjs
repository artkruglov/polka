#!/usr/bin/env node
// The stand's dispatcher (deploy/contour-stand/README.md): turns a task of a
// profile into a sandboxed run of a third-party agent and closes it. Runs as
// root inside the VM (stand.sh run), next to Docker; no dependencies.
//
//   dispatcher.mjs run <profile.yaml> "<task>" --as <user>   start, wait, close
//   dispatcher.mjs start <profile.yaml> "<task>" --as <user> start only, print the task id
//     (--command "<cmd>" replaces the profile's sandbox command; checks.sh uses it)
//   dispatcher.mjs wait <task_id>                             wait for the run and close it
//   dispatcher.mjs revoke <task_id>                           stop now: process, model key, network
//   dispatcher.mjs status [task_id]                           runs and their state
//
// One task: the person proves who they are in Keycloak and must hold the
// profile's role; the dispatcher reserves the budget as a LiteLLM key, asks
// Полка for a task token, opens the task's address in Squid, starts the
// sandbox (gVisor) and writes every step as an event with the task id.
// swarm.mjs imports start, wait and the helpers to run the steps of a goal.
import { execFile as execFileCb, spawn } from "node:child_process";
import { createPublicKey, createVerify, randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const STATE = "/var/lib/contour";
const TASKS = join(STATE, "tasks");
const WORK = join(STATE, "work");
const SQUID_TASKS = "/etc/squid/contour-tasks.conf";
const KEYCLOAK = "http://127.0.0.1:8080/realms/contour";
const LITELLM = "http://127.0.0.1:4000";
const BAO = "http://127.0.0.1:8200";
const SUBNET = "10.77.0";
// What a profile's network line may name, as Squid ACLs (squid.conf). The
// systems of record are readable only: GET, never a write.
const DESTINATIONS = {
  polka: "p_polka",
  model: "p_model",
  git: "p_git",
  systems: "p_systems m_read",
  fin: "p_fin m_read",
};

// ---- profile: the YAML subset profiles and process packs use (maps two
// levels deep, [a, b] lists, {a: b} maps, «|» blocks, # comments).
export function parseProfile(text) {
  const root = {};
  let section = null,
    block = null;
  for (const raw of text.split("\n")) {
    if (block) {
      if (/^\s+\S/.test(raw) || raw === "") {
        block.lines.push(raw.replace(/^ {2}/, ""));
        continue;
      }
      block.target[block.key] = block.lines.join("\n").trim();
      block = null;
    }
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (!line.trim()) continue;
    const m = /^( *)([\w.-]+):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`profile: cannot read «${raw}»`);
    const [, indent, key, value] = m;
    const target = indent ? section : root;
    if (indent && !section) throw new Error(`profile: «${key}» is indented under nothing`);
    if (value === "|") {
      block = { target, key, lines: [] };
      continue;
    }
    if (value === "" && !indent) {
      section = root[key] = {};
      continue;
    }
    if (!indent) section = null;
    target[key] = scalar(value);
  }
  if (block) block.target[block.key] = block.lines.join("\n").trim();
  return root;
}
function scalar(value) {
  if (/^\{.*\}$/.test(value))
    return Object.fromEntries(
      value
        .slice(1, -1)
        .split(",")
        .map((pair) => pair.split(":").map((v) => v.trim()))
        .filter(([k]) => k)
        .map(([k, v]) => [k, scalar(v ?? "")]),
    );
  if (/^\[.*\]$/.test(value))
    return value
      .slice(1, -1)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  return value.replace(/^"(.*)"$/, "$1");
}

// ---- helpers
const now = () => new Date().toISOString();
async function event(task, layer, type, data = {}) {
  const goal = task.goal ? { goal_id: task.goal } : {};
  const line = JSON.stringify({
    ts: now(),
    task_id: task.id,
    ...goal,
    profile: task.profile,
    layer,
    event: type,
    ...data,
  });
  await mkdir(task.journal, { recursive: true });
  await appendFile(join(task.journal, `${task.id}.jsonl`), line + "\n");
  await appendFile(join(task.journal, "all.jsonl"), line + "\n");
  console.log(`  [${layer}] ${type}${Object.keys(data).length ? " " + JSON.stringify(data) : ""}`);
}
export async function http(url, { method = "GET", headers = {}, body, form } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text };
}
export async function bao(path) {
  const { root_token } = JSON.parse(await readFile("/etc/contour/bao-init.json", "utf8"));
  const r = await http(`${BAO}/v1/contour/data/${path}`, { headers: { "x-vault-token": root_token } });
  if (r.status !== 200) throw new Error(`OpenBao: no secret contour/${path} (${r.status})`);
  return r.json.data.data;
}
const docker = (...args) => execFile("docker", args, { maxBuffer: 1 << 24 });
// Written whole and renamed: swarm.mjs runs several tasks in one process,
// and a reader must never see half a file.
async function saveTask(task) {
  const file = join(TASKS, `${task.id}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(task, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
}
// Address allocation and the Squid file are shared by concurrent tasks.
let netQueue = Promise.resolve();
const serial = (fn) => (netQueue = netQueue.then(fn, fn));
export const loadTask = async (id) => JSON.parse(await readFile(join(TASKS, `${id}.json`), "utf8"));
async function tasks() {
  await mkdir(TASKS, { recursive: true });
  const names = (await readdir(TASKS)).filter((n) => n.endsWith(".json"));
  return Promise.all(names.map((n) => loadTask(n.slice(0, -5))));
}

// ---- identity: Keycloak password grant for the stand's test users, the
// token's signature checked against the realm's keys.
export async function verifyJwt(token) {
  const [h, p, s] = token.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const { keys } = (await http(`${KEYCLOAK}/protocol/openid-connect/certs`)).json;
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Keycloak: unknown signing key");
  const ok = createVerify("RSA-SHA256")
    .update(`${h}.${p}`)
    .verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new Error("Keycloak: bad token signature");
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  if (claims.exp * 1000 < Date.now()) throw new Error("Keycloak: token expired");
  return claims;
}
export async function signIn(user, { raw = false } = {}) {
  const { password } = await bao(`users/${user}`);
  const r = await http(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    form: { grant_type: "password", client_id: "dispatcher", username: user, password, scope: "openid" },
  });
  if (r.status !== 200) throw new Error(`Keycloak: ${user} cannot sign in (${r.status} ${r.json?.error ?? ""})`);
  return raw ? r.json.access_token : verifyJwt(r.json.access_token);
}

// ---- network: one Squid ACL per running task, keyed by its sandbox address.
const renderSquid = () => serial(writeSquid);
async function writeSquid() {
  const running = (await tasks()).filter((t) => t.state === "running" && t.ip);
  const lines = ["# Generated by dispatcher.mjs: one block per running task."];
  for (const t of running) {
    const acl = `t_${t.id.replace(/[^\w]/g, "_")}`;
    lines.push(`acl ${acl} src ${t.ip}/32`);
    for (const name of t.network) lines.push(`http_access allow ${acl} to_lo ${DESTINATIONS[name]}`);
  }
  await writeFile(SQUID_TASKS, lines.join("\n") + "\n");
  await execFile("squid", ["-k", "reconfigure"]);
}
async function freeIp() {
  const used = new Set((await tasks()).filter((t) => t.state === "running").map((t) => t.ip));
  for (let n = 10; n < 250; n++) if (!used.has(`${SUBNET}.${n}`)) return `${SUBNET}.${n}`;
  throw new Error("no free sandbox address");
}

// ---- start
// A profile is a YAML path (the CLI) or an object (swarm.mjs builds one per
// step of a goal). prepare(work) fills the work folder before the sandbox
// starts: inputs, the skill from the catalog.
export async function start(source, text, user, { command, prepare, goal } = {}) {
  const profile = typeof source === "string" ? parseProfile(await readFile(source, "utf8")) : structuredClone(source);
  if (command) profile.sandbox.command = command;
  const id = `task-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
  const task = {
    id,
    profile: profile.profile,
    title: profile.title,
    text,
    requestedBy: user,
    goal: goal ?? null,
    owner: profile.owner,
    journal: profile.journal ?? join(STATE, "events"),
    network: profile.network?.allow ?? [],
    sandbox: profile.sandbox,
    model: profile.model,
    state: "starting",
    created: now(),
  };
  for (const name of task.network) if (!DESTINATIONS[name]) throw new Error(`profile: unknown destination «${name}»`);
  await mkdir(TASKS, { recursive: true });
  await event(task, "flow", "requested", { by: user, text: text.slice(0, 200) });

  // Identity: who asks, and may they delegate this type of task?
  const claims = await signIn(user);
  const roles = claims.realm_access?.roles ?? [];
  if (!roles.includes(profile.delegate_role)) {
    await event(task, "identity", "refused", { user, need: profile.delegate_role });
    task.state = "refused";
    await saveTask(task);
    throw new Error(`${user} has no role ${profile.delegate_role}: the task is refused`);
  }
  await event(task, "identity", "delegated", {
    user,
    sub: claims.sub,
    role: profile.delegate_role,
    owner: profile.owner,
  });

  // Model: a key for this task only, limited to the profile's models,
  // budget and lifetime. The provider's key stays in the gateway.
  const { master_key } = await bao("litellm");
  const ttl = Number(profile.sandbox?.ttl_minutes ?? 15);
  const key = await http(`${LITELLM}/key/generate`, {
    method: "POST",
    headers: { authorization: `Bearer ${master_key}` },
    body: {
      models: profile.model.models,
      max_budget: profile.model.budget_usd,
      duration: `${ttl + 5}m`,
      key_alias: id,
      metadata: { task_id: id, requested_by: user },
    },
  });
  if (key.status !== 200) throw new Error(`LiteLLM: key not issued (${key.status} ${key.text.slice(0, 200)})`);
  task.modelKeyHash = key.json.token; // LiteLLM's hash of the key: enough to look up spend and delete it
  await event(task, "model", "key-issued", {
    models: profile.model.models,
    budget_usd: profile.model.budget_usd,
    minutes: ttl + 5,
  });

  // Полка: a task token of the profile's service account, if it names one.
  let polkaToken = "";
  if (profile.access?.polka_bot) {
    const bot = await bao(`polka/${profile.access.polka_bot}`);
    const issued = await http(`${bot.origin}/api/v1/task-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${bot.token}` },
      body: { minutes: ttl + 5, taskId: id },
    });
    if (issued.status !== 200)
      throw new Error(`Полка: task token not issued (${issued.status} ${issued.text.slice(0, 200)})`);
    polkaToken = issued.json.token;
    await event(task, "access", "task-token", {
      bot: profile.access.polka_bot,
      scopes: issued.json.scopes,
      minutes: ttl + 5,
    });
  }

  // Work folder: the task text and the profile's instructions.
  const work = join(WORK, id);
  await mkdir(join(work, ".home"), { recursive: true });
  const instructions = (profile.instructions ?? "").replaceAll("{task_id}", id);
  await writeFile(join(work, "TASK.md"), `${text}\n\n${instructions}\n`);
  if (prepare) await prepare(work);
  await execFile("chown", ["-R", "1000:1000", work]);
  await chmod(work, 0o700);

  // Network, then the sandbox.
  await serial(async () => {
    task.ip = await freeIp();
    task.state = "running";
    task.started = now();
    task.ttlMinutes = ttl;
    await saveTask(task);
    await writeSquid();
  });
  await event(task, "network", "opened", { ip: task.ip, allow: task.network });

  const proxy = `http://${SUBNET}.1:3128`;
  const s = profile.sandbox;
  const args = [
    "run",
    "-d",
    "--name",
    id,
    "--runtime=runsc",
    "--network",
    "task-net",
    "--ip",
    task.ip,
    "--cpus",
    String(s.cpus ?? 1),
    "--memory",
    String(s.memory ?? "1g"),
    "--pids-limit",
    "512",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=256m",
    "-v",
    `${work}:/work`,
    "--label",
    `contour.task=${id}`,
    "-e",
    `HTTP_PROXY=${proxy}`,
    "-e",
    `HTTPS_PROXY=${proxy}`,
    "-e",
    `http_proxy=${proxy}`,
    "-e",
    `https_proxy=${proxy}`,
    "-e",
    "NO_PROXY=",
    "-e",
    "no_proxy=",
    "-e",
    `TASK_ID=${id}`,
    "-e",
    `CONTOUR_MODEL_KEY=${key.json.key}`,
    "-e",
    `POLKA_MCP_TOKEN=${polkaToken}`,
    s.image,
    ...String(s.command ?? "codex").split(" "),
  ];
  const { stdout } = await docker(...args);
  task.container = stdout.trim().slice(0, 12);
  await saveTask(task);
  await event(task, "sandbox", "started", {
    runtime: "runsc",
    image: s.image,
    cpus: s.cpus,
    memory: s.memory,
    ttl_minutes: ttl,
  });
  return task;
}

// ---- wait and close
export async function wait(id) {
  let task = await loadTask(id);
  if (task.state !== "running") return task;
  const deadline = new Date(task.started).getTime() + task.ttlMinutes * 60_000;
  const left = Math.max(1, Math.round((deadline - Date.now()) / 1000));
  const waiter = spawn("docker", ["wait", task.container]);
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiter.kill();
      resolve("ttl");
    }, left * 1000);
    let out = "";
    waiter.stdout.on("data", (d) => (out += d));
    waiter.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
  task = await loadTask(id);
  if (task.state !== "running") return task; // revoked meanwhile
  if (exit === "ttl") {
    await docker("kill", task.container).catch(() => {});
    await event(task, "sandbox", "ttl-expired", { minutes: task.ttlMinutes });
  } else await event(task, "sandbox", "exited", { code: Number(exit) });
  return close(task, exit === "ttl" ? "ttl" : Number(exit) === 0 ? "done" : "failed");
}

async function spend(task) {
  // LiteLLM writes spend in batches (proxy_batch_write_at: 2 in provision.sh).
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const { master_key } = await bao("litellm");
  const r = await http(`${LITELLM}/key/info?key=${encodeURIComponent(task.modelKeyHash)}`, {
    headers: { authorization: `Bearer ${master_key}` },
  });
  return r.status === 200 ? Number(r.json.info?.spend ?? 0) : null;
}
async function dropKey(task) {
  const { master_key } = await bao("litellm");
  return http(`${LITELLM}/key/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${master_key}` },
    body: { keys: [task.modelKeyHash] },
  });
}
async function networkSummary(task) {
  // Squid's native log: «time elapsed client action/code size method url …».
  const log = await readFile("/var/log/squid/access.log", "utf8").catch(() => "");
  const since = new Date(task.started).getTime() / 1000;
  const rows = log
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[2] === task.ip && Number(f[0]) >= since);
  const denied = rows.filter((f) => /DENIED|\/403/.test(f[3]));
  return {
    requests: rows.length,
    denied: denied.length,
    denied_urls: [...new Set(denied.map((f) => f[6]))].slice(0, 10),
  };
}

async function close(task, outcome) {
  const cost = await spend(task);
  await dropKey(task);
  await event(task, "model", "key-closed", { spend_usd: cost });
  task.state = outcome;
  task.finished = now();
  task.spendUsd = cost;
  await saveTask(task);
  await renderSquid();
  await event(task, "network", "closed", await networkSummary(task));
  const last = await readFile(join(WORK, task.id, "LAST.md"), "utf8").catch(() => "");
  const logs = await docker("logs", "--tail", "200", task.container).catch((e) => ({
    stdout: e.stdout ?? "",
    stderr: e.stderr ?? "",
  }));
  await writeFile(join(WORK, task.id, "container.log"), (logs.stdout ?? "") + (logs.stderr ?? ""));
  await docker("rm", "-f", task.container).catch(() => {});
  const minutes = Math.round((new Date(task.finished) - new Date(task.started)) / 600) / 100;
  await event(task, "flow", "closed", {
    outcome,
    minutes,
    spend_usd: cost,
    awaiting: outcome === "done" ? "приёмка на Полке" : null,
  });
  task.lastMessage = last.trim();
  await saveTask(task);
  return task;
}

export async function revoke(id) {
  const task = await loadTask(id);
  if (task.state !== "running") throw new Error(`${id} is ${task.state}, not running`);
  const t0 = performance.now();
  task.state = "revoking";
  await saveTask(task);
  await docker("kill", task.container).catch(() => {});
  const killed = performance.now() - t0;
  await dropKey(task);
  const keyGone = performance.now() - t0;
  await renderSquid();
  const netClosed = performance.now() - t0;
  const ms = (v) => Math.round(v);
  await event(task, "flow", "revoked", {
    process_killed_ms: ms(killed),
    model_key_deleted_ms: ms(keyGone),
    network_closed_ms: ms(netClosed),
  });
  task.state = "running"; // close() records the outcome
  return close(task, "revoked");
}

// ---- cli (only when run directly, not when swarm.mjs imports this file)
const main = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
const [command, ...rest] = main ? process.argv.slice(2) : [];
const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
const as = option("--as");
const print = (task) => {
  console.log(
    `\n${task.id} · ${task.profile} · ${task.state}${task.spendUsd != null ? ` · $${task.spendUsd.toFixed(4)}` : ""}`,
  );
  if (task.lastMessage) console.log(`\n${task.lastMessage}`);
};
try {
  if (!main) {
    // imported
  } else if (command === "run" || command === "start") {
    const [profile, text] = rest;
    if (!profile || !text || !as)
      throw new Error(`usage: dispatcher.mjs ${command} <profile.yaml> "<task>" --as <user>`);
    const task = await start(profile, text, as, { command: option("--command") });
    if (command === "start") console.log(task.id);
    else print(await wait(task.id));
  } else if (command === "wait") print(await wait(rest[0]));
  else if (command === "revoke") print(await revoke(rest[0]));
  else if (command === "status") {
    for (const t of rest[0] ? [await loadTask(rest[0])] : await tasks())
      console.log(
        `${t.id}  ${t.profile.padEnd(8)} ${t.state.padEnd(9)} ${t.requestedBy ?? ""}  ${t.spendUsd != null ? "$" + t.spendUsd.toFixed(4) : ""}`,
      );
  } else {
    console.log(
      (await readFile(new URL(import.meta.url), "utf8"))
        .split("\n")
        .slice(4, 11)
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n"),
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`dispatcher: ${error.message}`);
  process.exitCode = 1;
}
