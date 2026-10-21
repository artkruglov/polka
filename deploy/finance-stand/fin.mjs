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
//   fin.mjs score [--journal <name> --review <file>]   tails against the reference, or against a bookkeeper's marks
//   fin.mjs selftest                                the stand's boundaries (checks.sh, block 6)
//   fin.mjs audit --dir <exports> [--check] [--as-of D] [--terms 10]   a company's own exports: the passport, then the reconciliation in its own journal
//   fin.mjs review --journal <name> [--out <file>]  the audit's tails as a sheet for the bookkeeper to mark
//   fin.mjs sync <company> [--audit] [--as-of D]   the company's direct connections (connectors/sync.mjs), then the audit of what they brought
//   fin.mjs secret <company> <source>               a source's credentials, JSON on stdin, into OpenBao; never printed
//   fin.mjs chase | remind | inbox | recon [--as petrova]   the follow-up steps, each a goal of its pack
//   fin.mjs exceptions [--number <счёт>]            each new open exception once on Полка: accepting it is the person's decision
//   fin.mjs cycle [--as petrova]                    one working day: inbox, match, exceptions, chase, remind
//   fin.mjs due [--at <ISO time>] [--dry]           the steps whose timer is due (schedule.mjs, finance-schedule.timer)
//   fin.mjs decide <счёт> <исключение> "<решение>" --as <user>   a person closes an exception
//   fin.mjs sign --as <user>                        sign the reconciliation drafts in EDO (a signer only)
import { execFile as execFileCb, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { write } from "./company/gen.mjs";
import * as tbank from "./adapters/tbank.mjs";
import { operations as clientBank } from "./adapters/clientbank.mjs";
import { CONTOUR, contour } from "./contour.mjs";
import { fromExceptions, fromInbox, fromJournal, fromStates, fromSystems, writeInputs } from "./inputs.mjs";
import { passportLines, readExports } from "./imports/audit.mjs";
import { sync, syncLines } from "./connectors/sync.mjs";
import { reviewSheet, scoreReview } from "./review.mjs";
import { JOURNAL, apply, decide, fold, journal, metrics, tails } from "./obligations.mjs";
import { beforeEffect, journalOf, project, projectionOf } from "./hooks.mjs";
import { due, timedPacks } from "./schedule.mjs";

const execFile = promisify(execFileCb);
const DATA = "/var/lib/finance";
export const FIN = "http://127.0.0.1:7071";
const effectsToken = () => readFile("/etc/contour/effects-token", "utf8").then((t) => t.trim());
const bao = async (path) => (await contour("dispatcher.mjs")).bao(path);
const baoPut = async (path, data) => (await contour("dispatcher.mjs")).baoPut(path, data);
const COMPANIES = "/etc/finance/companies";
const companyConfig = async (name) => {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name ?? "")) throw new Error("имя компании: латиница, цифры и дефис");
  return JSON.parse(await readFile(join(COMPANIES, `${name}.json`), "utf8"));
};
// What each kind of source keeps in OpenBao.
const SECRET_KEYS = { tbank: ["token"], odata1c: ["user", "password"], imap: ["user", "password"] };

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
  сумма: "сумма УПД ≠ счёт",
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

// The export passport, then fin.match in a journal of its own; `head`
// (the connectors' run) goes on top of the passport.
async function auditDir(dir, args, head = []) {
  const terms = Number(opt(args, "--terms", 10));
  const { inputs, passport } = await readExports(dir, { asOf: opt(args, "--as-of"), terms });
  const lines = [...head, ...(head.length ? [""] : []), ...passportLines(passport)];
  console.log(passportLines(passport).join("\n"));
  if (args.includes("--check")) return;
  const name = `audit-${inputs.firm.inn ?? "x"}-${stamp()}`;
  console.log(`\nжурнал ${name}`);
  // The passport goes with the inputs: the result on Полка says what it was built from.
  await reconcile({ ...inputs, passport: lines }, {
    as: opt(args, "--as", "petrova"),
    title: `Аудит хвостов: ${inputs.firm.name ?? inputs.firm.inn} на ${inputs.firm.asOf}`,
    params: { journal: name, as_of: inputs.firm.asOf },
  });
  console.log(`хвосты: fin.mjs tails --journal ${name}; разметка бухгалтером: fin.sh review ${name} <файл.csv>`);
}

const commands = {
  async reset(args) {
    const seed = Number(opt(args, "--seed", 41));
    const quarter = opt(args, "--quarter", "2026Q3");
    await execFile("systemctl", ["stop", "finance-systems"]);
    // a new synthetic firm; companies' audits and connections stay
    for (const e of await readdir(DATA).catch(() => []))
      if (!["audit", "companies"].includes(e)) await rm(join(DATA, e), { recursive: true, force: true });
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
    await auditDir(dir, args);
  },

  // A company's direct connections: what is new since the last run, laid
  // into its folder beside the hand-made exports; --audit reconciles it all.
  async sync(args) {
    const [name] = args;
    const config = await companyConfig(name);
    const root = join(DATA, "companies", name);
    const report = await sync({ config, root, secret: (id) => bao(`finance/companies/${name}/${id}`) });
    const head = syncLines(report);
    console.log(head.join("\n"));
    if (args.includes("--audit"))
      await auditDir(join(root, "exports"), [...args, ...(config.asOf && !args.includes("--as-of") ? ["--as-of", config.asOf] : [])], head);
    process.exitCode = report.sources.every((x) => x.ok) ? process.exitCode : 1;
  },

  // Credentials come from whoever holds them, on stdin; they go to OpenBao
  // and nowhere else, and are never printed.
  async secret(args) {
    const [name, id] = args;
    const config = await companyConfig(name);
    const src = config.sources.find((x) => x.id === id);
    if (!src) throw new Error(`у ${name} нет источника ${id}: ${config.sources.map((x) => x.id).join(", ")}`);
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const value = JSON.parse(raw);
    const need = SECRET_KEYS[src.kind] ?? [];
    const gaps = need.filter((k) => typeof value[k] !== "string" || !value[k]);
    if (gaps.length) throw new Error(`нужны поля ${need.join(", ")}; нет: ${gaps.join(", ")}`);
    await baoPut(`finance/companies/${name}/${id}`, Object.fromEntries(need.map((k) => [k, value[k]])));
    console.log(`${name}/${id}: записано в OpenBao (${need.join(", ")})`);
  },

  async review(args) {
    const name = opt(args, "--journal");
    if (!name) throw new Error("--journal <имя журнала аудита>");
    const file = journalOf({ journal: name });
    const asOf = JSON.parse(await readFile(projectionOf(file), "utf8")).asOf;
    await mkdir(join(DATA, "audit"), { recursive: true, mode: 0o700 });
    const out = opt(args, "--out", join(DATA, "audit", `${name}.review.csv`));
    const t = tails(await journal(file), asOf);
    await writeFile(out, reviewSheet(t), { mode: 0o600 });
    console.log(`${out}: хвостов ${t.length}. В колонке «верно» — да или нет; пропущенный хвост — новой строкой с «пропущено».`);
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
  async score(args = []) {
    if (opt(args, "--review")) {
      const file = opt(args, "--review");
      const r = scoreReview(file, await readFile(file));
      const pct = (x) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
      console.log(
        `верно ${r.confirmed}, неверно ${r.wrong}, пропущено ${r.missed}, не размечено ${r.unmarked}: точность ${pct(r.precision)}, полнота ${pct(r.recall)}`,
      );
      for (const w of r.wrongRows) console.log(`  неверно: ${w}`);
      for (const m of r.missedRows) console.log(`  пропущено: ${m}`);
      process.exitCode = r.precision >= 0.95 && r.recall >= 0.95 ? 0 : 1;
      return;
    }
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

  // Each open exception goes to Полка once (fin.exceptions): the page says
  // what happened and the safe decision; accepting the version records it.
  async exceptions(args) {
    const file = join(DATA, "exceptions.json");
    const sent = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
    const day = await today();
    const only = opt(args, "--number");
    const fresh = fromExceptions({ events: await journal(), company: await company(), today: day }).filter(
      (x) => !sent[x.key] && (!only || x.number === only),
    );
    if (!fresh.length) return console.log("новых исключений нет");
    for (const x of fresh) {
      await reconcile(x.inputs, {
        as: opt(args, "--as", "petrova"),
        title: `Исключение по ${x.number}: ${KIND[x.kind] ?? x.kind}`,
        params: {},
        process: "fin.exceptions",
      });
      sent[x.key] = day;
      await writeFile(file, JSON.stringify(sent, null, 2));
    }
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
    for (const step of ["inbox", "match", "exceptions", "chase", "remind"]) {
      console.log(`\n== ${step}`);
      await commands[step](args);
    }
  },

  // The packs' timers: what is due runs in a working day's order; a slot
  // counts as run only when its step went through.
  async due(args) {
    const at = opt(args, "--at") ? new Date(opt(args, "--at")) : new Date();
    const file = join(DATA, "schedule.json");
    const last = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
    const run = due(await timedPacks(), last, at);
    if (args.includes("--dry")) return run.forEach((p) => console.log(`${p.process}  ${p.timer}`));
    let failed = 0;
    for (const p of run) {
      console.log(`\n== ${p.process} (${p.timer})`);
      try {
        await commands[p.step](args);
        if (p.slot) last[p.process] = p.slot.toISOString();
      } catch (error) {
        failed++;
        console.error(`${p.process}: ${error.message}`);
      }
    }
    await writeFile(file, JSON.stringify(last, null, 2));
    process.exitCode = failed ? 1 : 0;
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

  // Each line is «ok» when the boundary holds; the real services, nothing mocked.
  async selftest() {
    let fail = 0;
    const line = (ok, name, detail) => {
      if (!ok) fail = 1;
      console.log(`${ok ? "ok  " : "fail"} ${name.padEnd(22)} ${detail}`);
    };
    const post = (path, body, headers = {}) =>
      fetch(`${FIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const c = await company();
    const supplier = c.counterparties.find((x) => x.role === "supplier" && x.edo);

    // 1. Writes need the gateway's token; 2. the banks need theirs.
    const w = await post("/edo/request", { inn: supplier.inn, basis: "П-0101" });
    line(w.status === 401, "fin-no-token", `запрос документа без токена шлюза → ${w.status}`);
    const b = await fetch(`${FIN}/tbank/api/v4/bank-accounts`);
    line(b.status === 401, "bank-no-token", `выписка без токена банка → ${b.status}`);

    // 3. No payment among the stand's effects, and the policy denies one.
    const routes = JSON.parse(await readFile(new URL("./effects/finance.json", import.meta.url), "utf8"));
    const payLike = Object.keys(routes).filter((t) => /pay|transfer|плат/i.test(t));
    const { http } = await contour("dispatcher.mjs");
    const opa = await http("http://127.0.0.1:8181/v1/data/contour/accept/decision", {
      method: "POST",
      body: {
        input: {
          process: {
            name: "fin.chase",
            department: "finance",
            autonomy: 3,
            reviewer_required: false,
            effects: { "bank.payment": { auto_from: 0 }, "edo.request": { auto_from: 2 } },
          },
          result: { checks: { passed: [], failed: [] }, executor: { vendor: "skill-script" }, reviewer: null },
          effects: [{ type: "bank.payment", amount: 415330, to: "40702810999900001234" }],
          sample: 0.99,
        },
      },
    });
    const d = opa.json?.result?.effects?.[0];
    line(
      !payLike.length && d?.decision === "deny",
      "no-payment-effect",
      `маршрутов платежа ${payLike.length}; bank.payment → ${d?.decision} (${d?.why})`,
    );

    // 3a. A decision on an exception is a person's whatever the pack says.
    const opa2 = await http("http://127.0.0.1:8181/v1/data/contour/accept/decision", {
      method: "POST",
      body: {
        input: {
          process: {
            name: "fin.exceptions",
            department: "finance",
            autonomy: 3,
            reviewer_required: false,
            effects: { "fin.decision": { auto_from: 0 } },
          },
          result: { checks: { passed: [], failed: [] }, executor: { vendor: "skill-script" }, reviewer: null },
          effects: [{ type: "fin.decision", basis: "selftest", kind: "реквизиты", decision: "Реквизиты не меняем" }],
          sample: 0.99,
        },
      },
    });
    const d2 = opa2.json?.result?.effects?.[0];
    line(
      d2?.decision === "human",
      "decision-by-person",
      `fin.decision на ступени 3 с auto_from 0 → ${d2?.decision} (${d2?.why})`,
    );

    // 4. New requisites in a letter go to a person, and the agent stops writing.
    const id = "ob-selftest";
    const at = "2026-10-05T10:00:00Z";
    const detected = { type: "Detected", id, at, data: { side: "ap", inn: "1", number: "selftest", amount: 1000 } };
    const letter = "У нас сменились банковские реквизиты, оплачивайте на новый счёт";
    const r1 = decide(fold(id, [detected]), { type: "Response", id, text: letter }, at);
    const r2 = decide(fold(id, [detected, ...r1.events]), { type: "RequestDocument", id, via: "edo" }, at);
    line(
      r1.events.some((e) => e.type === "ExceptionRaised" && e.data.kind === "реквизиты") &&
        /реквизит/.test(r2.refused ?? ""),
      "requisites-to-person",
      `письмо о новых реквизитах → исключение; следующий запрос → ${r2.refused ?? "ушёл"}`,
    );

    // 5. The same request twice is one request.
    const key = `selftest:${randomBytes(3).toString("hex")}`;
    const tok = (await readFile("/etc/contour/effects-token", "utf8")).trim();
    const h = { "x-effects-token": tok, "idempotency-key": key };
    const one = await (
      await post("/edo/request", { inn: supplier.inn, basis: "selftest", text: "Самопроверка стенда" }, h)
    ).json();
    const two = await (
      await post("/edo/request", { inn: supplier.inn, basis: "selftest", text: "Самопроверка стенда" }, h)
    ).json();
    line(
      one.id && one.id === two.id && two.repeated,
      "edo-request-idempotent",
      `два вызова → ${one.id}${two.repeated ? ", повтор" : ""}`,
    );

    // 6. The journal refuses a second letter within three days before the gateway.
    const name = `selftest-${randomBytes(2).toString("hex")}`;
    const file = journalOf({ journal: name });
    const day = await today();
    await apply(
      [
        {
          type: "Detect",
          id: "ob-П-9999",
          side: "ap",
          inn: supplier.inn,
          name: supplier.name,
          number: "П-9999",
          amount: 1000,
          due: "2026-09-01",
        },
        { type: "RequestDocument", id: "ob-П-9999", via: "edo" },
      ],
      { at: `${day}T09:00:00Z`, file },
    );
    const veto = await beforeEffect(
      { id: "selftest", params: { journal: name } },
      { type: "edo.request", basis: "П-9999" },
    );
    line(/не чаще/.test(veto ?? ""), "ask-limit", `второй запрос в тот же день → ${veto ?? "пропущен"}`);
    await rm(file, { force: true });

    // 7. The firm's view rebuilt from its journal is the live one.
    const live = JSON.parse(await readFile(projectionOf(JOURNAL), "utf8").catch(() => "null"));
    if (!live) line(true, "rebuild", "журнал пуст: сверка ещё не запускалась");
    else {
      const again = await project(JOURNAL, live.asOf);
      line(
        JSON.stringify(again.tails) === JSON.stringify(live.tails),
        "rebuild",
        `из журнала (${again.events} событий) та же картина`,
      );
    }

    // 8. A company's systems answer the connectors only with its credentials,
    // and none of them lands in the company's folder.
    const demo = await readFile(join(COMPANIES, "demo.json"), "utf8").then(JSON.parse, () => null);
    if (demo) {
      const bank = await fetch(`${demo.sources.find((x) => x.kind === "tbank").base}/api/v4/bank-accounts`).then((r) => r.status, () => 0);
      const odata = await fetch(`${demo.sources.find((x) => x.kind === "odata1c").base}/Catalog_Контрагенты`).then((r) => r.status, () => 0);
      // no secret read means nothing to look for: that fails, it does not pass
      const secrets = await Promise.all(demo.sources.map((x) => bao(`finance/companies/demo/${x.id}`).catch(() => null)));
      const values = secrets.flatMap((x) => [x?.token, x?.password]).filter(Boolean);
      const folder = join(DATA, "companies", "demo");
      const files = (await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])).filter((e) => e.isFile());
      let leaked = 0;
      for (const e of files) {
        const text = await readFile(join(e.parentPath, e.name), "utf8");
        if (values.some((v) => text.includes(v))) leaked++;
      }
      line(
        bank === 401 && odata === 401 && !leaked && secrets.every(Boolean) && files.length > 0,
        "connector-credentials",
        secrets.every(Boolean)
          ? `банк без токена → ${bank}, 1С без пароля → ${odata}; файлов компании с секретом: ${leaked} из ${files.length}`
          : `не прочитал секреты компании demo в OpenBao: ${demo.sources.filter((_, i) => !secrets[i]).map((x) => x.id).join(", ")}`,
      );
    }

    // 9. The finance skills reach a sandbox only as admitted.
    const { verifiedSkill } = await contour("catalog.mjs");
    const skills = (await readdir(new URL("./catalog/skills/", import.meta.url))).sort();
    const bad = [];
    for (const sk of skills) await verifiedSkill(sk).catch((e) => bad.push(e.message));
    line(!bad.length, "fin-skills-admitted", bad.length ? bad.join("; ") : `${skills.join(", ")} совпадают с допуском`);
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
