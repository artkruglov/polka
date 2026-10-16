#!/usr/bin/env node
// Checks that an agent's sandbox really holds (docs/specs/AGENT_SANDBOX.md).
// Every probe runs twice: once outside the sandbox, where it must work (or
// the check proves nothing), and once through the runner, where it must
// not. A probe that fails for another reason — a missing tool, a timeout, a
// broken runner — is «not checked», never «blocked». The report is evidence
// of one run, not an admission.
//
//   node polka-sandbox-check.mjs --runner "srt --settings /etc/agent-stand/srt.json -c" \
//     --canary /home/agent/.ssh/id_canary --canary /opt/agent-stand/canary/secret \
//     --allowed-read /work/probe.txt --work /work \
//     --allowed-url http://127.0.0.1:4390/api/health --blocked-url https://example.com \
//     [--settings-file /etc/agent-stand/srt.json] [--json report.json]
//
// --runner is a command prefix that takes one shell command string as its
// last argument; "none" runs probes with bash -c (no sandbox). No
// dependencies: Node 22+. Exit 0: every probe blocked; 1: something was not
// blocked; 2: something could not be checked.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, release, type } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `Usage: polka-sandbox-check --runner "<prefix>"|none [--canary <file>]... [--allowed-read <file>]
  [--work <dir>] [--allowed-url <url>] [--blocked-url <url>] [--settings-file <file>] [--json <file>]`;
const TIMEOUT_MS = 15_000;

/** Quoted for a POSIX shell. */
export const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/**
 * One probe's verdict from its two runs. control: did the action work
 * outside; inside: did it work through the runner (null: the run itself
 * broke — timeout, missing tool). An expected-to-work probe (positive) is
 * «ok» when it works inside and «fails» when it does not.
 */
export function verdict({ control, inside, positive = false }) {
  if (positive) return inside === true ? "ok" : "fails";
  if (control !== true || inside === null) return "not-checked";
  return inside ? "NOT-BLOCKED" : "blocked";
}

/** Runs one shell command, optionally through the runner. */
export function run(runner, command, env, timeoutMs = TIMEOUT_MS) {
  const line = runner && runner !== "none" ? `${runner} ${shellQuote(command)}` : command;
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", line], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, timedOut: signal === "SIGKILL", stdout, stderr });
    });
  });
}

const has = (result, needle) => !result.timedOut && result.stdout.includes(needle);
// The proxy variables of srt list 127.0.0.1 as «no proxy»; inside the
// sandbox the only way out is the proxy, so probes clear them.
const OUT = "NO_PROXY= no_proxy= ";

/** The probes for these options: [{section, id, what, command, expect, positive?}]. */
export async function plan(options, canaryEnv) {
  const probes = [];
  probes.push({
    section: "runtime",
    id: "runner",
    what: "команда в песочнице выполняется",
    command: "echo sandbox-ok",
    expect: "sandbox-ok",
    positive: true,
  });
  if (options["allowed-read"]) {
    const value = (await readFile(options["allowed-read"], "utf8")).trim();
    probes.push({
      section: "runtime",
      id: "read-allowed",
      what: `чтение разрешённого ${options["allowed-read"]}`,
      command: `cat ${shellQuote(options["allowed-read"])}`,
      expect: value,
      positive: true,
    });
  }
  // Each way of reading must first read the allowed file inside the
  // sandbox: a tool that does not start there would look «blocked».
  const readers = {
    cat: (file) => `cat ${shellQuote(file)}`,
    bash: (file) => `bash -c ${shellQuote(`cat ${shellQuote(file)}`)}`,
    python: (file) => `python3 -c ${shellQuote(`print(open(${JSON.stringify(file)}).read())`)}`,
    node: (file) =>
      `node -e ${shellQuote(`process.stdout.write(require("fs").readFileSync(${JSON.stringify(file)},"utf8"))`)}`,
  };
  const allowed = options["allowed-read"];
  const allowedValue = allowed ? (await readFile(allowed, "utf8")).trim() : null;
  for (const file of options.canary ?? []) {
    let value = null;
    try {
      value = (await readFile(file, "utf8")).trim();
    } catch {}
    for (const [via, reader] of Object.entries(readers))
      probes.push({
        section: "runtime",
        id: `read:${via}:${file}`,
        what: `чтение ${file} через ${via}`,
        command: reader(file),
        expect: value,
        toolCheck: allowed ? { command: reader(allowed), expect: allowedValue } : null,
      });
  }
  probes.push({
    section: "launcher",
    id: "env",
    what: "секрет из окружения запуска",
    command: "env",
    expect: canaryEnv.value,
  });
  if (options.work) {
    const name = `polka-check-${randomBytes(4).toString("hex")}`;
    probes.push({
      section: "runtime",
      id: "write-work",
      what: `запись в ${options.work}`,
      command: `echo ok > ${shellQuote(join(options.work, name))} && cat ${shellQuote(join(options.work, name))} && rm -f ${shellQuote(join(options.work, name))}`,
      expect: "ok",
      positive: true,
    });
  }
  const outside = join(homedir(), `.polka-check-${randomBytes(4).toString("hex")}`);
  probes.push({
    section: "runtime",
    id: "write-home",
    what: `запись вне рабочей папки (${outside})`,
    command: `echo ok > ${shellQuote(outside)} && cat ${shellQuote(outside)} && rm -f ${shellQuote(outside)}`,
    expect: "ok",
  });
  if (options["allowed-url"])
    probes.push({
      section: "runtime",
      id: "net-allowed",
      what: `разрешённый адрес ${options["allowed-url"]}`,
      command: `${OUT}curl -sS -m 8 -o /dev/null -w 'http=%{http_code}' ${shellQuote(options["allowed-url"])}`,
      expect: "http=2",
      positive: true,
    });
  if (options["blocked-url"]) {
    const url = options["blocked-url"];
    const allowedUrl = options["allowed-url"];
    const curl = (target) => `${OUT}curl -sS -m 8 -o /dev/null -w 'http=%{http_code}' ${shellQuote(target)}`;
    const python = (target) =>
      `${OUT}python3 -c ${shellQuote(`import urllib.request;print("http=%d" % urllib.request.urlopen(${JSON.stringify(target)}, timeout=8).status)`)}`;
    // The tool must work inside: on the allowed address when there is one,
    // else at least start (a sandbox without any network has no address).
    const tool = (make, starts) =>
      allowedUrl ? { command: make(allowedUrl), expect: "http=2" } : { command: starts, expect: "tool-ok" };
    probes.push({
      section: "runtime",
      id: "net-curl",
      toolCheck: tool(curl, "curl --version >/dev/null && echo tool-ok"),
      what: `выход в сеть: curl ${url}`,
      command: `${OUT}curl -sS -m 8 -o /dev/null -w 'http=%{http_code}' ${shellQuote(url)}`,
      expect: "http=2",
    });
    probes.push({
      section: "runtime",
      id: "net-python",
      toolCheck: tool(python, `python3 -c ${shellQuote('import urllib.request;print("tool-ok")')}`),
      what: `выход в сеть: python ${url}`,
      command: `${OUT}python3 -c ${shellQuote(`import urllib.request;print("http=%d" % urllib.request.urlopen(${JSON.stringify(url)}, timeout=8).status)`)}`,
      expect: "http=2",
    });
    const host = new URL(url).hostname;
    probes.push({
      section: "runtime",
      id: "dns",
      what: `DNS-запрос ${host}`,
      command: `python3 -c ${shellQuote(`import socket;print("resolved", socket.gethostbyname(${JSON.stringify(host)}))`)}`,
      expect: "resolved",
    });
  }
  if (existsSync("/var/run/docker.sock"))
    probes.push({
      section: "runtime",
      id: "docker",
      what: "Docker через /var/run/docker.sock",
      command: "curl -sS -m 5 --unix-socket /var/run/docker.sock http://d/_ping",
      expect: "OK",
    });
  else probes.push({ section: "runtime", id: "docker", what: "Docker через /var/run/docker.sock", na: true });
  return probes;
}

export async function check(options, { runImpl = run } = {}) {
  const canaryEnv = {
    name: `POLKA_CHECK_CANARY_${randomBytes(3).toString("hex").toUpperCase()}`,
    value: randomBytes(18).toString("base64url"),
  };
  const env = { ...process.env, [canaryEnv.name]: canaryEnv.value };
  const runner = options.runner;
  const results = [];
  for (const probe of await plan(options, canaryEnv)) {
    if (probe.na) {
      results.push({ section: probe.section, id: probe.id, what: probe.what, status: "n/a" });
      continue;
    }
    // A tool that does not work inside proves nothing by failing there.
    if (probe.toolCheck !== undefined) {
      const works = probe.toolCheck && has(await runImpl(runner, probe.toolCheck.command, env), probe.toolCheck.expect);
      if (!works) {
        results.push({
          section: probe.section,
          id: probe.id,
          what: probe.what,
          status: "not-checked",
          detail: probe.toolCheck ? "инструмент не работает в песочнице" : "нет разрешённого образца для сверки",
        });
        continue;
      }
    }
    // Without a value to look for (an unreadable canary) nothing is proved.
    const control = probe.positive
      ? null
      : probe.expect
        ? has(await runImpl("none", probe.command, env), probe.expect)
        : false;
    const insideRun = await runImpl(runner, probe.command, env);
    const inside = insideRun.timedOut ? null : has(insideRun, probe.expect ?? "\u0000");
    // A probe through a runner that never started (exit 126/127) proves nothing.
    const broken = !inside && (insideRun.code === 126 || insideRun.code === 127);
    results.push({
      section: probe.section,
      id: probe.id,
      what: probe.what,
      status: verdict({ control, inside: broken ? null : inside, positive: probe.positive }),
      ...(insideRun.timedOut ? { detail: "таймаут" } : {}),
    });
  }
  // A runner that cannot run «echo» or read its own work folder is broken:
  // every «blocked» behind it is meaningless.
  const runnerBroken = results.some((r) => r.status !== "ok" && (r.id === "runner" || r.id === "read-allowed"));
  if (runnerBroken) for (const r of results) if (r.status === "blocked") r.status = "not-checked";
  let settingsSha256 = null;
  if (options["settings-file"])
    settingsSha256 = createHash("sha256")
      .update(await readFile(options["settings-file"]))
      .digest("hex");
  return {
    format: "polka-sandbox-check/1",
    note: "Свидетельство одного прогона, а не допуск. Не проверяет утечку через разрешённые адреса и уязвимости ядра.",
    at: new Date().toISOString(),
    system: `${type()} ${release()}`,
    runner,
    settingsSha256,
    results,
  };
}

export const exitCode = (report) =>
  report.results.some((r) => r.status === "NOT-BLOCKED")
    ? 1
    : report.results.some((r) => r.status === "not-checked" || r.status === "fails")
      ? 2
      : 0;

const MARK = {
  blocked: "заблокировано",
  "NOT-BLOCKED": "НЕ ЗАБЛОКИРОВАНО",
  "not-checked": "не проверено",
  ok: "работает",
  "n/a": "не применимо",
  fails: "не работает",
};
export function table(report) {
  const lines = [
    `Песочница: ${report.runner}`,
    `Система: ${report.system}`,
    report.settingsSha256 ? `Настройки sha256: ${report.settingsSha256}` : null,
    report.note,
    "",
  ].filter((l) => l !== null);
  for (const r of report.results)
    lines.push(`${MARK[r.status].padEnd(18)} ${r.section.padEnd(9)} ${r.what}${r.detail ? ` (${r.detail})` : ""}`);
  return lines.join("\n") + "\n";
}

export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, runImpl } = {},
) {
  let options;
  try {
    ({ values: options } = parseArgs({
      args: argv,
      options: {
        runner: { type: "string" },
        canary: { type: "string", multiple: true },
        "allowed-read": { type: "string" },
        work: { type: "string" },
        "allowed-url": { type: "string" },
        "blocked-url": { type: "string" },
        "settings-file": { type: "string" },
        json: { type: "string" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    stderr.write(`polka-sandbox-check: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help || !options.runner) {
    stdout.write(`${USAGE}\n`);
    return options.help ? 0 : 2;
  }
  const report = await check(options, runImpl ? { runImpl } : {});
  stdout.write(table(report));
  if (options.json) await writeFile(options.json, JSON.stringify(report, null, 2) + "\n");
  return exitCode(report);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await main();
