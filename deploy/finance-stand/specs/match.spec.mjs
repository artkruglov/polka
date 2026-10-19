// The reconciliation skill against the bookkeeper's reference, and the
// journal of obligations against the skill (deploy/finance-stand/README.md).
// Runs python3 on the host: node --test deploy/finance-stand/specs/*.spec.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../company/gen.mjs";
import { fromFirm, writeInputs } from "../inputs.mjs";
import { apply, journal, metrics, tails } from "../obligations.mjs";

const SKILL = fileURLToPath(new URL("../catalog/skills/fin-match/", import.meta.url));
const key = (number, kind, sum) => `${number}|${kind}|${sum}`;

for (const seed of [41, 7, 13, 99, 2026]) {
  test(`seed ${seed}: the skill finds the reference tails, the journal agrees`, async () => {
    const work = mkdtempSync(join(tmpdir(), "fin-match-"));
    try {
      const firm = generate({ seed });
      await writeInputs(join(work, "in"), fromFirm(firm));
      execFileSync("python3", [join(SKILL, "run.py")], { env: { ...process.env, WORK: work } });
      const review = JSON.parse(
        execFileSync("python3", [join(SKILL, "check.py")], { env: { ...process.env, WORK: work } }),
      );
      assert.deepEqual(review.failed, []);

      const rows = readFileSync(join(work, "out", "tails.csv"), "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((l) => l.split(";"));
      const got = new Set(rows.map((r) => key(r[0], r[4], r[5])));
      const want = new Set(firm.expected.map((r) => key(r[0], r[4], r[5])));
      const hit = [...got].filter((k) => want.has(k)).length;
      assert.ok(hit / got.size >= 0.95, `precision ${hit}/${got.size}`);
      assert.ok(hit / want.size >= 0.95, `recall ${hit}/${want.size}`);

      const file = join(work, "events.jsonl");
      const cmds = readFileSync(join(work, "out", "proposals.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const { refused } = await apply(cmds, { at: "2026-09-30T18:00:00Z", file });
      assert.deepEqual(refused, []);
      const asOf = firm.firm.period.asOf;
      const projected = new Set(tails(await journal(file), asOf).map((t) => key(t.number, t.kind, t.sum.toFixed(2))));
      assert.deepEqual([...projected].sort(), [...got].sort());
      // The journal replayed again gives the same view.
      assert.deepEqual(metrics(await journal(file), asOf), metrics(await journal(file), asOf));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

// A company's own exports (fin.mjs audit): the same firm written as the
// files a bookkeeper would hand over gives the same tails.
test("exports in the audit's formats give the same tails", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { fromExports } = await import("../inputs.mjs");
  const { clientBankExchange, cp1251, tapiOperation } = await import("../company/gen.mjs");
  const work = mkdtempSync(join(tmpdir(), "fin-audit-"));
  try {
    const c = generate({ seed: 41 });
    const dir = join(work, "exports");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "tbank.json"),
      JSON.stringify({ operations: c.bankA.map((o) => tapiOperation(o, c.firm, c.accounts.a)) }),
    );
    writeFileSync(join(dir, "severny.txt"), cp1251(clientBankExchange(c.bankB, c.firm, c.accounts.b, c.firm.period)));
    writeFileSync(
      join(dir, "firm.json"),
      JSON.stringify({ inn: c.firm.inn, name: c.firm.name, asOf: c.firm.period.asOf }),
    );
    const cps = Object.fromEntries(c.ledger.Catalog_Контрагенты.map((k) => [k.Ref_Key, k]));
    const inv = (side, d) =>
      [
        d.Number,
        d.Date.slice(0, 10),
        cps[d.Контрагент_Key].ИНН,
        cps[d.Контрагент_Key].Description,
        side,
        d.СуммаДокумента,
        d.СрокОплаты.slice(0, 10),
      ].join(";");
    writeFileSync(
      join(dir, "invoices.csv"),
      [
        "номер;дата;инн;контрагент;сторона;сумма;срок",
        ...c.ledger.Document_СчетНаОплатуПоставщика.map((d) => inv("ap", d)),
        ...c.ledger.Document_СчетНаОплатуПокупателю.map((d) => inv("ar", d)),
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "edo.csv"),
      [
        "номер;дата;инн;контрагент;вид;направление;сумма;ндс;основание;статус",
        ...c.edo.map((d) =>
          [
            d.number,
            d.date,
            d.inn,
            d.counterparty,
            d.kind === "upd" ? "УПД" : "Счёт",
            d.dir === "in" ? "входящий" : "исходящий",
            d.amount,
            d.vat,
            d.basis,
            d.status === "signed" ? "подписан" : "ждёт подписи",
          ].join(";"),
        ),
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "receipts.csv"),
      [
        "основание;сумма",
        ...[...c.ledger.Document_ПоступлениеТоваровУслуг, ...c.ledger.Document_РеализацияТоваровУслуг].map(
          (d) => `${d.ДокументОснование};${d.СуммаДокумента}`,
        ),
      ].join("\n"),
    );
    await writeInputs(join(work, "in"), await fromExports(dir));
    execFileSync("python3", [join(SKILL, "run.py")], { env: { ...process.env, WORK: work } });
    const rows = readFileSync(join(work, "out", "tails.csv"), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(";"));
    assert.deepEqual(
      rows.map((r) => key(r[0], r[4], r[5])).sort(),
      c.expected.map((r) => key(r[0], r[4], r[5])).sort(),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
