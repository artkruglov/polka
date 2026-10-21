// Exceptions on Полка (fin.exceptions, catalog/skills/fin-decide, hooks.mjs):
// each open exception gets a page and one safe decision; the decision is
// recorded only through the gateway, after a person accepts, and only once.
// node --test deploy/finance-stand/specs/*.spec.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = fileURLToPath(new URL("../catalog/skills/fin-decide/", import.meta.url));
// The firm's journal here, not in /var/lib/finance: set before the modules read it.
const DATA = mkdtempSync(join(tmpdir(), "fin-decide-"));
process.env.FIN_DATA = DATA;
process.env.FIN_JOURNAL = join(DATA, "events.jsonl");
const { fromExceptions, writeInputs } = await import("../inputs.mjs");
const { effect, beforeEffect } = await import("../hooks.mjs");

const at = "2026-09-25T09:00:00Z";
const ev = (type, id, data) => ({ type, id, at, data, by: null });
const ob = (n, side, amount) =>
  ev("Detected", `ob-${n}`, {
    side,
    inn: `77${n.slice(-4)}`,
    name: `ООО «${n}»`,
    number: n,
    amount,
    due: "2026-09-20",
  });
const events = [
  ob("П-0116", "ap", 50000),
  ev("PaymentMatched", "ob-П-0116", { opId: "a-1", amount: 50000, date: "2026-09-02" }),
  ev("ResponseReceived", "ob-П-0116", {
    from: "buh@x.test",
    summary: "у нас сменились реквизиты, оплачивайте на новый счёт",
  }),
  ev("ExceptionRaised", "ob-П-0116", { kind: "реквизиты", why: "контрагент пишет о новых реквизитах" }),
  ob("П-0120", "ap", 122000),
  ev("PaymentMatched", "ob-П-0120", { opId: "a-2", amount: 122000, date: "2026-09-03" }),
  ev("DocumentMatched", "ob-П-0120", { docId: "e-1", kind: "upd", amount: 122000, vat: 20333.33, ok: false }),
  ev("ExceptionRaised", "ob-П-0120", { kind: "ошибка_ндс", why: "НДС не по законной ставке" }),
  ob("П-0130", "ap", 30000),
  ev("PaymentMatched", "ob-П-0130", { opId: "a-3", amount: 30000, date: "2026-09-04" }),
  ev("PaymentMatched", "ob-П-0130", { opId: "a-4", amount: 30000, date: "2026-09-05" }),
  ev("ExceptionRaised", "ob-П-0130", { kind: "дубль_оплаты", why: "второй платёж" }),
];
const company = { firm: { name: "ООО «Стеллаж-Про»", inn: "7700000000" } };
const skill = async (inputs) => {
  const work = mkdtempSync(join(tmpdir(), "fin-decide-w-"));
  await writeInputs(join(work, "in"), inputs);
  const env = { ...process.env, WORK: work };
  execFileSync("python3", [join(SKILL, "run.py")], { env });
  const checks = JSON.parse(execFileSync("python3", [join(SKILL, "check.py")], { env }).toString());
  return {
    checks,
    effects: JSON.parse(readFileSync(join(work, "out", "effects.json"), "utf8")),
    page: readFileSync(join(work, "out", "result.md"), "utf8"),
  };
};

test("each open exception once, with its obligation's grounds", () => {
  const xs = fromExceptions({ events, company, today: "2026-09-30" });
  assert.deepEqual(
    xs.map((x) => [x.number, x.kind]),
    [
      ["П-0116", "реквизиты"],
      ["П-0120", "ошибка_ндс"],
      ["П-0130", "дубль_оплаты"],
    ],
  );
  assert.equal(new Set(xs.map((x) => x.key)).size, 3);
  assert.equal(xs[0].inputs.exception.responses.length, 1);
  assert.equal(xs[2].inputs.exception.payments.length, 2);
});

test("the skill: one safe decision per exception, a page with the grounds, its checks pass", async () => {
  for (const x of fromExceptions({ events, company, today: "2026-09-30" })) {
    const r = await skill(x.inputs);
    assert.deepEqual(r.checks.failed, [], `${x.number}: ${r.checks.failed}`);
    assert.equal(r.effects.length, 1);
    assert.equal(r.effects[0].type, "fin.decision");
    assert.match(r.page, new RegExp(x.number));
  }
  const requisites = await skill(fromExceptions({ events, company, today: "2026-09-30" })[0].inputs);
  assert.match(requisites.effects[0].decision, /не меняем/);
  assert.match(requisites.page, /ничего не закрывают/);
});

test("the checks catch a decision that pays or names an account", async () => {
  const x = fromExceptions({ events, company, today: "2026-09-30" })[0];
  const work = mkdtempSync(join(tmpdir(), "fin-decide-w-"));
  await writeInputs(join(work, "in"), x.inputs);
  const env = { ...process.env, WORK: work };
  execFileSync("python3", [join(SKILL, "run.py")], { env });
  writeFileSync(
    join(work, "out", "effects.json"),
    JSON.stringify([
      {
        type: "fin.decision",
        basis: "П-0116",
        kind: "реквизиты",
        decision: "Оплатить на новый счёт 40702810900000000001",
      },
    ]),
  );
  const checks = JSON.parse(execFileSync("python3", [join(SKILL, "check.py")], { env }).toString());
  assert.ok(checks.failed.includes("в решении нет номеров счетов"));
  assert.ok(checks.failed.includes("решение ничего не оплачивает"));
});

test("an accepted decision closes the exception once; a gone exception is not decided again", async () => {
  writeFileSync(join(DATA, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const g = { id: "goal-1", params: {}, polka: { artifactId: "a1b2" } };
  const e = { type: "fin.decision", basis: "П-0116", kind: "реквизиты", decision: "Реквизиты не меняем" };
  assert.equal(await beforeEffect(g, e), null);
  const first = await effect(g, e, "goal-1:0");
  assert.equal(first.status, 200);
  const again = await effect(g, e, "goal-1:0");
  assert.deepEqual([again.status, again.json.repeated], [200, true]);
  assert.match(await beforeEffect(g, e), /уже закрыто: Реквизиты не меняем/);
  const decided = readFileSync(join(DATA, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.includes("HumanDecided"));
  assert.equal(decided.length, 1);
  assert.match(decided[0], /человек на Полке, работа a1b2/);
});
