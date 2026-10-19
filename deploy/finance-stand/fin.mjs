#!/usr/bin/env node
// The finance stand's console (deploy/finance-stand/README.md). Runs as root
// in the VM from /opt/contour/finance; fin.sh calls it from the host.
//
//   fin.mjs reset [--seed 41] [--quarter 2026Q3]   a new synthetic firm, the systems from zero
//   fin.mjs status                                  the simulator's day and what the systems hold
//   fin.mjs statement [--bank a|b] [--sandbox]      a bank's operations through the adapter
//   fin.mjs contract                                the adapter against the bank's public sandbox
//   fin.mjs advance <days>                          move the counterparties' clock forward
import { execFile as execFileCb } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { write } from "./company/gen.mjs";
import * as tbank from "./adapters/tbank.mjs";
import { operations as clientBank } from "./adapters/clientbank.mjs";
import { contour } from "./contour.mjs";

const execFile = promisify(execFileCb);
const DATA = "/var/lib/finance";
export const FIN = "http://127.0.0.1:7071";
const effectsToken = () => readFile("/etc/contour/effects-token", "utf8").then((t) => t.trim());
const bao = async (path) => (await contour("dispatcher.mjs")).bao(path);

/** The firm's banks as the coordinator reads them: the token stays here. */
export async function readBank(which, { from, to } = {}) {
  const company = JSON.parse(await readFile(join(DATA, "company", "company.json"), "utf8"));
  from ??= company.firm.period.from;
  const { token } = await bao("finance/bank");
  if (which === "a") {
    const ops = await tbank.statement({ base: `${FIN}/tbank`, token, account: company.accounts.a.account, from, to });
    return ops.map((o) => tbank.normalize(o, "a"));
  }
  const r = await fetch(`${FIN}/bankb/statement.txt`, { headers: { authorization: `Bearer ${token}` } });
  if (r.status !== 200) throw new Error(`банк b: ${r.status}`);
  return clientBank(Buffer.from(await r.arrayBuffer()), "b").filter((o) => o.date >= from && (!to || o.date < to));
}

async function fin(method, path, body) {
  const r = await fetch(`${FIN}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-effects-token": await effectsToken() },
    body: body && JSON.stringify(body),
  });
  return r.json();
}

const commands = {
  async reset(args) {
    const seed = Number(opt(args, "--seed", 41));
    const quarter = opt(args, "--quarter", "2026Q3");
    await execFile("systemctl", ["stop", "finance-systems"]);
    await rm(DATA, { recursive: true, force: true });
    const c = await write(join(DATA, "company"), { seed, quarter });
    await execFile("systemctl", ["start", "finance-systems"]);
    for (let i = 0; i < 20; i++) {
      if (
        await fetch(`${FIN}/health`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(
      `${c.firm.name}, ${quarter}: контрагентов ${c.counterparties.length}, операций ${c.bankA.length + c.bankB.length}, ` +
        `документов ЭДО ${c.edo.length}, заложено хвостов ${c.expected.length}`,
    );
  },

  async status() {
    const h = await (await fetch(`${FIN}/health`)).json();
    const clock = await (await fetch(`${FIN}/sim/clock`)).json();
    const edo = await (await fetch(`${FIN}/edo/documents`)).json();
    const inbox = await (await fetch(`${FIN}/mail/inbox?box=finance`)).json();
    const out = await (await fetch(`${FIN}/mail/outbox`)).json();
    console.log(`день симулятора ${h.clock}; ждут ответа ${clock.scheduled}`);
    console.log(`ЭДО: ${edo.length} документов; письма: входящих ${inbox.length}, исходящих ${out.length}`);
  },

  async statement(args) {
    const sandbox = args.includes("--sandbox");
    const which = opt(args, "--bank", "a");
    let ops;
    if (sandbox) {
      const token = tbank.SANDBOX_TOKEN;
      const [acc] = await tbank.accounts({ base: tbank.SANDBOX, token });
      const raw = await tbank.statement({ base: tbank.SANDBOX, token, account: acc.accountNumber, from: "2020-01-01" });
      ops = raw.map((o) => tbank.normalize(o, "sandbox"));
    } else ops = await readBank(which, { from: opt(args, "--from"), to: opt(args, "--to") });
    const sum = (d) => ops.filter((o) => o.direction === d).reduce((s, o) => s + o.amount, 0);
    console.log(`операций ${ops.length}: приход ${sum("in").toFixed(2)}, расход ${sum("out").toFixed(2)}`);
    for (const o of ops.slice(0, Number(opt(args, "--limit", 5))))
      console.log(
        `  ${o.date} ${o.direction === "in" ? "+" : "-"}${o.amount.toFixed(2)} ${o.name || "—"} · ${o.purpose.slice(0, 70)}`,
      );
  },

  // The adapter against the real API: the same calls, the fields it needs.
  async contract() {
    let fail = 0;
    const line = (verdict, name, detail) => {
      if (verdict === "fail") fail = 1;
      console.log(`${verdict.padEnd(4)} ${name.padEnd(22)} ${detail}`);
    };
    const token = tbank.SANDBOX_TOKEN;
    try {
      const accounts = await tbank.accounts({ base: tbank.SANDBOX, token });
      const acc = accounts[0];
      line(
        acc?.accountNumber ? "ok" : "fail",
        "tbank-accounts",
        `счетов ${accounts.length}, первый ${acc?.accountNumber ?? "—"}`,
      );
      const ops = await tbank.statement({ base: tbank.SANDBOX, token, account: acc.accountNumber, from: "2020-01-01" });
      const gaps = [...new Set(ops.flatMap(tbank.missing))];
      line(
        ops.length && !gaps.length ? "ok" : "fail",
        "tbank-statement",
        `операций ${ops.length}${gaps.length ? `, нет полей: ${gaps.join(", ")}` : ", поля адаптера на месте"}`,
      );
      const n = tbank.normalize(ops[0], "sandbox");
      line(
        n.opId && n.date && n.amount > 0 && n.direction ? "ok" : "fail",
        "tbank-normalize",
        `${n.date} ${n.direction} ${n.amount} ${n.name}`,
      );
    } catch (error) {
      line(
        /ENOTFOUND|EAI_AGAIN|timeout|ECONNREFUSED|ENETUNREACH|нет корня/.test(error.message) ? "skip" : "fail",
        "tbank-api",
        error.message,
      );
    }
    try {
      const tools = await tbank.mcpTools();
      const want = ["getApiV1Statement", "getApiV4Bank-accounts"];
      const ro = want.every((w) => tools.find((t) => t.name === w)?.readOnly);
      line(
        ro ? "ok" : "fail",
        "tbank-mcp",
        `инструментов ${tools.length}; ${want.join(", ")} ${ro ? "только чтение" : "не найдены как чтение"}`,
      );
    } catch (error) {
      line(
        /ENOTFOUND|EAI_AGAIN|timeout|ECONNREFUSED|ENETUNREACH|нет корня/.test(error.message) ? "skip" : "fail",
        "tbank-mcp",
        error.message,
      );
    }
    process.exitCode = fail;
  },

  async advance(args) {
    const r = await fin("POST", "/sim/advance", { days: Number(args[0] ?? 1) });
    console.log(`день ${r.date}`);
    for (const d of r.delivered) console.log(`  ${d}`);
  },
};

function opt(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const [command, ...args] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!commands[command]) {
      const head = (await readFile(new URL(import.meta.url), "utf8")).split("\n").slice(4, 9);
      console.log(head.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exitCode = 2;
    } else await commands[command](args);
  } catch (error) {
    console.error(`fin: ${error.message}`);
    process.exitCode = 1;
  }
}
