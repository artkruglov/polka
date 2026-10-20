// The audit on a company's own exports (fin.mjs audit): the synthetic firm
// written as a bookkeeper hands it over (company/exports.mjs) gives the
// reference tails; the passport says what it took and what does not add up.
// node --test deploy/finance-stand/specs/*.spec.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientBankExchange, cp1251, generate } from "../company/gen.mjs";
import { realistic, writeExports } from "../company/exports.mjs";
import { readExports, passportLines } from "../imports/audit.mjs";
import { amount, date, nameKey } from "../imports/tables.mjs";
import { readXlsx, writeXlsx } from "../imports/xlsx.mjs";
import { writeInputs } from "../inputs.mjs";
import { apply, journal, tails } from "../obligations.mjs";
import { reviewSheet, scoreReview } from "../review.mjs";

const SKILL = fileURLToPath(new URL("../catalog/skills/fin-match/", import.meta.url));
const key = (number, kind, sum) => `${number}|${kind}|${sum}`;
const run = (work) => {
  execFileSync("python3", [join(SKILL, "run.py")], { env: { ...process.env, WORK: work } });
  return JSON.parse(execFileSync("python3", [join(SKILL, "check.py")], { env: { ...process.env, WORK: work } }));
};
const tailsOf = (work) =>
  readFileSync(join(work, "out", "tails.csv"), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(";"));

for (const seed of [41, 7, 13, 99, 2026]) {
  test(`seed ${seed}: a bookkeeper's exports give the reference tails`, async () => {
    const work = mkdtempSync(join(tmpdir(), "fin-exports-"));
    try {
      const { firm, quirks } = realistic(generate({ seed }));
      assert.equal(quirks.length, 3, quirks.join("; "));
      await writeExports(firm, join(work, "exports"));
      const { inputs, passport } = await readExports(join(work, "exports"));
      assert.deepEqual(
        passport.warnings.filter((w) => /не сходится|не нашёл|не понял/.test(w)),
        [],
      );
      assert.ok(
        passport.files.every((f) => f.kind),
        JSON.stringify(passport.files.filter((f) => !f.kind)),
      );
      assert.deepEqual(
        passport.banks.map((b) => b.check),
        ["сходится", "сходится"],
      );
      assert.equal(passport.firm.inn, firm.firm.inn); // read off the bank files, no firm.json
      await writeInputs(join(work, "in"), { ...inputs, passport: passportLines(passport) });
      assert.deepEqual(run(work).failed, []);
      assert.deepEqual(
        tailsOf(work)
          .map((r) => key(r[0], r[4], r[5]))
          .sort(),
        firm.expected.map((r) => key(r[0], r[4], r[5])).sort(),
      );
      const proposals = readFileSync(join(work, "out", "proposals.jsonl"), "utf8");
      assert.match(proposals, /"opId": "[^"]+\/ИСХ-\d+"/, "one order split between two invoices");
      assert.match(proposals, /"id": "ob-15@\d+"/, "the same number at two suppliers");
      assert.match(readFileSync(join(work, "out", "result.md"), "utf8"), /## Из чего собрано/);

      // The journal, fed the skill's commands, shows the same tails.
      const file = join(work, "events.jsonl");
      const { refused } = await apply(
        proposals
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l)),
        { at: "2026-09-30T18:00:00Z", file },
      );
      assert.deepEqual(refused, []);
      assert.deepEqual(
        tails(await journal(file), inputs.firm.asOf)
          .map((t) => key(t.number, t.kind, t.sum.toFixed(2)))
          .sort(),
        firm.expected.map((r) => key(r[0], r[4], r[5])).sort(),
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

test("a statement cut short does not add up to the bank's totals", async () => {
  const work = mkdtempSync(join(tmpdir(), "fin-cut-"));
  try {
    const c = generate({ seed: 41 });
    const text = clientBankExchange(c.bankB, c.firm, c.accounts.b, c.firm.period);
    const cut = text.replace(/СекцияДокумент=[\s\S]*?КонецДокумента\r\n/, ""); // the first order lost
    writeFileSync(join(work, "bank.txt"), cp1251(cut));
    writeFileSync(join(work, "notes.docx"), "x");
    const { passport } = await readExports(work);
    assert.match(passport.banks[0].check, /^не сходится/);
    assert.ok(passport.warnings.some((w) => w.includes("не сходится")));
    assert.ok(passport.warnings.some((w) => w.includes("нет счетов")));
    assert.equal(passport.files.find((f) => f.file === "notes.docx").kind, null);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("names, amounts and dates as 1C, banks and Excel write them", () => {
  assert.equal(nameKey("ООО «Альфа-Строй»"), nameKey('Общество с ограниченной ответственностью "АЛЬФА-СТРОЙ"'));
  assert.equal(nameKey("Альфа-Строй ООО"), "альфа строй");
  assert.equal(nameKey("ИП Ковалёв А. С."), nameKey("Индивидуальный предприниматель Ковалев А.С."));
  assert.equal(amount("1 234 567,89"), 1234567.89);
  assert.equal(amount("1234.5 руб."), 1234.5);
  assert.equal(amount(990), 990);
  assert.equal(date(46204), "2026-07-01");
  assert.equal(date("01.07.2026 0:00:00"), "2026-07-01");
  assert.equal(date("1.7.26"), "2026-07-01");
  const rows = [
    ["Дата", "Номер", "Сумма"],
    [46204, "П-01 & <«x»>", 1234.5],
  ];
  assert.deepEqual(readXlsx(writeXlsx(rows)), rows);
});

test("the bookkeeper's marks give precision and recall", () => {
  const sheet = reviewSheet([
    { number: "П-0101", side: "ap", name: "А", inn: "1", kind: "нет_упд", sum: 100 },
    { number: "П-0102", side: "ap", name: "Б", inn: "2", kind: "нет_упд", sum: 200 },
    { number: "ИСХ-0501", side: "ar", name: "В", inn: "3", kind: "просрочка", sum: 300 },
  ]);
  const marked = sheet
    .replace(/(П-0101;[^\r]*;)(;)/, "$1да$2")
    .replace(/(П-0102;[^\r]*;)(;)/, "$1нет$2")
    .replace(/(ИСХ-0501;[^\r]*;)(;)/, "$1да$2")
    .concat("П-0103;ap;Г;4;нет_упд;400.00;пропущено;оплатили с карты\r\n");
  const r = scoreReview("review.csv", cp1251(marked.replace(/^﻿/, "")));
  assert.deepEqual([r.confirmed, r.wrong, r.missed, r.unmarked], [2, 1, 1, 0]);
  assert.equal(r.precision, 2 / 3);
  assert.equal(r.recall, 2 / 3);
});
