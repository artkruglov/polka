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
//   fin.mjs score                                   the journal's tails against the bookkeeper's reference
//   fin.mjs audit --dir <exports> [--as petrova]    the same reconciliation on a company's own exports, its own journal
//   fin.mjs chase | remind | inbox | recon [--as petrova]   the follow-up steps, each a goal of its pack
//   fin.mjs cycle [--as petrova]                    one working day: inbox, match, chase, remind
//   fin.mjs decide <счёт> <исключение> "<решение>" --as <user>   a person closes an exception
//   fin.mjs sign --as <user>                        sign the reconciliation drafts in EDO (a signer only)
import { execFile as execFileCb, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { write } from "./company/gen.mjs";
import * as tbank from "./adapters/tbank.mjs";
import { operations as clientBank } from "./adapters/clientbank.mjs";
import { CONTOUR, contour } from "./contour.mjs";
import { fromExports, fromInbox, fromJournal, fromStates, fromSystems, writeInputs } from "./inputs.mjs";
import { JOURNAL, apply, journal, metrics, tails } from "./obligations.mjs";
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

async function fin(method, path, body, key) {
  const r = await fetch(`${FIN}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-effects-token": await effectsToken(),
      ...(key ? { "idempotency-key": key } : {}),
    },
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
const today = async () => (await (await fetch(`${FIN}/sim/clock`)).json()).date;
async function reconcile(inputs, { as, title, params, process = "fin.match" }) {
  const dir = join(DATA, "runs", stamp());
  const files = await writeInputs(dir, inputs);
  await swarm([
    "goal",
    title,
    "--process",
    process,
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
        `  ${r.number.padEnd(9)} ${(KIND[r.kind] ?? r.kind).padEnd(22)} ${String(r.sum?.toFixed(2) ?? "—").padStart(12)}  ${r.name}${r.asks ? ` · писали ${r.asks} ${[2, 3, 4].includes(r.asks % 10) && ![12, 13, 14].includes(r.asks % 100) ? "раза" : "раз"}` : ""}${r.open.length ? ` · исключение: ${r.open.join(", ")}` : ""}`,
      );
  },

  // Precision and recall against expected/tails.csv: right after the first
  // reconciliation, before anyone has written to a counterparty.
  async score() {
    const c = await company();
    const key = (n, k, sum) => `${n}|${k}|${Number(sum).toFixed(2)}`;
    const ref = (await readFile(join(DATA, "company", "expected", "tails.csv"), "utf8"))
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(";"));
    const want = new Set(ref.map((r) => key(r[0], r[4], r[5])));
    const got = new Set(tails(await journal(), c.firm.period.asOf).map((t) => key(t.number, t.kind, t.sum)));
    const hit = [...got].filter((k) => want.has(k)).length;
    const p = got.size ? hit / got.size : 0;
    const r = want.size ? hit / want.size : 0;
    console.log(
      `эталон ${want.size}, найдено ${got.size}, совпало ${hit}: точность ${(p * 100).toFixed(1)}%, полнота ${(r * 100).toFixed(1)}%`,
    );
    process.exitCode = p >= 0.95 && r >= 0.95 ? 0 : 1;
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

  async chase(args) {
    const day = await today();
    await reconcile(fromJournal({ events: await journal(), company: await company(), today: day }), {
      as: opt(args, "--as", "petrova"),
      title: `Запросить недостающие УПД на ${day}`,
      params: {},
      process: "fin.chase",
    });
  },

  async remind(args) {
    const day = await today();
    await reconcile(fromJournal({ events: await journal(), company: await company(), today: day }), {
      as: opt(args, "--as", "petrova"),
      title: `Напомнить должникам на ${day}`,
      params: {},
      process: "fin.remind",
    });
  },

  // New letters of the finance box become one goal; they are taken once.
  async inbox(args) {
    const letters = await (await fetch(`${FIN}/mail/inbox?box=finance&new`)).json();
    if (!letters.length) return console.log("новых писем нет");
    const day = await today();
    for (const m of letters)
      await fetch(`${FIN}/mail/take`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ box: "finance", id: m.id }),
      });
    await reconcile(fromInbox({ letters, events: await journal(), company: await company(), today: day }), {
      as: opt(args, "--as", "petrova"),
      title: `Разобрать ${letters.length} писем на ${day}`,
      params: {},
      process: "fin.inbox",
    });
  },

  async recon(args) {
    const day = await today();
    await reconcile(fromStates({ events: await journal(), company: await company(), today: day }), {
      as: opt(args, "--as", "petrova"),
      title: `Акты сверки на ${day}`,
      params: {},
      process: "fin.recon",
    });
  },

  async cycle(args) {
    for (const step of ["inbox", "match", "chase", "remind"]) {
      console.log(`\n== ${step}`);
      await commands[step](args);
    }
  },

  // An exception is closed by a person, named and checked by Keycloak.
  async decide(args) {
    const [number, kind, decision] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--as");
    const as = opt(args, "--as");
    if (!number || !kind || !decision || !as)
      throw new Error('usage: fin.mjs decide <счёт> <исключение> "<решение>" --as <user>');
    const { signIn } = await contour("dispatcher.mjs");
    await signIn(as); // a person of the realm, or this throws
    const at = `${await today()}T12:00:00Z`;
    const r = await apply([{ type: "Decide", id: `ob-${number}`, kind, decision, by: as }], { at, file: JOURNAL });
    if (r.refused.length) throw new Error(r.refused[0].why);
    await project(JOURNAL, (await company()).firm.period.asOf);
    console.log(
      `${number}: ${kind} — ${decision} (${as})${r.appended.some((e) => e.type === "Closed") ? "; обязательство закрыто" : ""}`,
    );
  },

  // Signing drafts in EDO: only a signer of the realm, only the queued bytes.
  async sign(args) {
    const as = opt(args, "--as");
    if (!as) throw new Error("usage: fin.mjs sign --as <подписант>");
    const { signIn, verifyJwt } = await contour("dispatcher.mjs");
    const claims = await verifyJwt(await signIn(as, { raw: true }));
    if (!(claims.realm_access?.roles ?? []).includes("signer")) throw new Error(`${as}: нет роли signer`);
    const drafts = await (await fetch(`${FIN}/edo/documents?dir=out&status=draft`)).json();
    for (const d of drafts) {
      const r = await fin("POST", "/edo/sign", { id: d.id, sha256: d.sha256, signer: as }, `sign:${d.id}`);
      console.log(`  ${d.counterparty}: ${r.status ?? r.error}`);
    }
    console.log(`подписано ${drafts.length}`);
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
