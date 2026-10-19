#!/usr/bin/env node
// The finance stand's console (deploy/finance-stand/README.md). Runs as root
// in the VM from /opt/contour/finance; fin.sh calls it from the host.
//
//   fin.mjs reset [--seed 41] [--quarter 2026Q3]   a new synthetic firm, the systems from zero
//   fin.mjs status                                  the simulator's day and what the systems hold
//   fin.mjs statement [--bank a|b] [--sandbox]      a bank's operations through the adapter
//   fin.mjs contract                                the adapter against the bank's public sandbox
//   fin.mjs advance <days>                          move the counterparties' clock forward
//   fin.mjs match [--as petrova]                    reconcile the firm: a goal of fin.match with what the systems hold
//   fin.mjs tails [--journal <name>]                the tails and the numbers, from the journal of obligations
//   fin.mjs rebuild [--journal <name>]              the view rebuilt from the journal, compared with the live one
//   fin.mjs audit --dir <exports> [--as petrova]    the same reconciliation on a company's own exports, its own journal
import { execFile as execFileCb, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { write } from "./company/gen.mjs";
import * as tbank from "./adapters/tbank.mjs";
import { operations as clientBank } from "./adapters/clientbank.mjs";
import { CONTOUR, contour } from "./contour.mjs";
import { fromExports, fromSystems, writeInputs } from "./inputs.mjs";
import { journal, metrics, tails } from "./obligations.mjs";
import { journalOf, project, projectionOf } from "./hooks.mjs";

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

const company = async () => JSON.parse(await readFile(join(DATA, "company", "company.json"), "utf8"));
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const KIND = {
  нет_упд: "оплачено, нет УПД",
  просрочка: "клиент просрочил",
  нет_оплаты: "УПД есть, не оплачено",
  частичная: "частичная оплата",
  ошибка_ндс: "ошибка НДС в УПД",
  дубль_оплаты: "оплачено дважды",
  учёт_эдо: "учёт ≠ ЭДО",
  реквизиты: "смена реквизитов",
};
// A goal of the swarm, as a person would put it (swarm.mjs goal).
function swarm(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [join(CONTOUR, "swarm.mjs"), ...args], { stdio: "inherit" });
    p.on("exit", (code) => (code ? reject(new Error(`swarm.mjs ${args[0]}: код ${code}`)) : resolve()));
  });
}
async function reconcile(inputs, { as, title, params }) {
  const dir = join(DATA, "runs", stamp());
  const files = await writeInputs(dir, inputs);
  await swarm([
    "goal",
    title,
    "--process",
    "fin.match",
    "--as",
    as,
    ...files.flatMap((f) => ["--file", f]),
    ...Object.entries(params).flatMap(([k, v]) => ["--param", `${k}=${v}`]),
  ]);
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

  async match(args) {
    const c = await company();
    const inputs = await fromSystems({ fin: FIN, readBank, company: c });
    console.log(`операций ${inputs.operations.length}, документов ЭДО ${inputs.edo.length}`);
    await reconcile(inputs, {
      as: opt(args, "--as", "petrova"),
      title: `Сверка денег и первички на ${c.firm.period.asOf}`,
      params: {},
    });
  },

  async audit(args) {
    const dir = opt(args, "--dir");
    if (!dir) throw new Error("--dir <папка с выгрузками компании>");
    const inputs = await fromExports(dir);
    const name = `audit-${inputs.firm.inn ?? "x"}-${stamp()}`;
    console.log(`операций ${inputs.operations.length}, документов ЭДО ${inputs.edo.length}, журнал ${name}`);
    await reconcile(inputs, {
      as: opt(args, "--as", "petrova"),
      title: `Аудит хвостов: ${inputs.firm.name ?? inputs.firm.inn} на ${inputs.firm.asOf}`,
      params: { journal: name, as_of: inputs.firm.asOf },
    });
    console.log(`хвосты: fin.mjs tails --journal ${name}`);
  },

  async tails(args) {
    const file = journalOf({ journal: opt(args, "--journal") });
    const asOf =
      opt(args, "--as-of") ??
      (await readFile(projectionOf(file), "utf8").then(
        (t) => JSON.parse(t).asOf,
        () => null,
      )) ??
      (await company()).firm.period.asOf;
    const events = await journal(file);
    const t = tails(events, asOf);
    const m = metrics(events, asOf);
    console.log(
      `на ${asOf}: обязательств ${m.obligations}, закрыто ${m.closed}, хвостов ${m.tails}; писем ${m.asks}, ответов ${m.responses}, решений человека ${m.decisions}, открытых исключений ${m.exceptionsOpen}`,
    );
    for (const r of t.slice(0, Number(opt(args, "--limit", 50))))
      console.log(
        `  ${r.number.padEnd(9)} ${(KIND[r.kind] ?? r.kind).padEnd(22)} ${String(r.sum?.toFixed(2) ?? "—").padStart(12)}  ${r.name}${r.asks ? ` · писали ${r.asks} раз` : ""}${r.open.length ? ` · исключение: ${r.open.join(", ")}` : ""}`,
      );
  },

  async rebuild(args) {
    const file = journalOf({ journal: opt(args, "--journal") });
    const live = JSON.parse(await readFile(projectionOf(file), "utf8"));
    const again = await project(file, live.asOf);
    const same =
      JSON.stringify(again.tails) === JSON.stringify(live.tails) &&
      JSON.stringify(again.metrics) === JSON.stringify(live.metrics);
    console.log(
      `${same ? "ok  " : "fail"} rebuild                из журнала (${again.events} событий) ${same ? "та же картина, что живая" : "картина разошлась с живой"}`,
    );
    process.exitCode = same ? 0 : 1;
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
