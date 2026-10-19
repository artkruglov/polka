// The synthetic firm and the bank adapters (deploy/finance-stand/README.md).
// Runs on the host, no VM: node --test deploy/finance-stand/specs
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientBankExchange, cp1251, generate, tapiOperation } from "../company/gen.mjs";
import { operations } from "../adapters/clientbank.mjs";
import { missing, normalize } from "../adapters/tbank.mjs";

const firm = generate({ seed: 41 });

test("the same seed gives the same firm", () => {
  assert.deepEqual(generate({ seed: 41 }), firm);
  assert.notDeepEqual(generate({ seed: 42 }).expected, firm.expected);
});

test("forty tails, each kind as planned", () => {
  const count = (kind) => firm.expected.filter((row) => row[4] === kind).length;
  assert.equal(firm.expected.length, 40);
  assert.deepEqual(
    { нет_упд: 16, просрочка: 9, нет_оплаты: 5, частичная: 4, ошибка_ндс: 3, дубль_оплаты: 2, учёт_эдо: 1 },
    Object.fromEntries(
      ["нет_упд", "просрочка", "нет_оплаты", "частичная", "ошибка_ндс", "дубль_оплаты", "учёт_эдо"].map((k) => [
        k,
        count(k),
      ]),
    ),
  );
});

test("bank a reads back through the T-API adapter", () => {
  for (const op of firm.bankA) {
    const t = tapiOperation(op, firm.firm, firm.accounts.a);
    assert.deepEqual(missing(t), []);
    const n = normalize(t, "a");
    assert.equal(n.amount, op.amount);
    assert.equal(n.direction, op.direction);
    assert.equal(n.inn, op.inn);
    assert.equal(n.purpose, op.purpose);
  }
});

test("bank b reads back from the windows-1251 exchange file", () => {
  const bytes = cp1251(clientBankExchange(firm.bankB, firm.firm, firm.accounts.b, firm.firm.period));
  const ops = operations(bytes, "b");
  assert.equal(ops.length, firm.bankB.length);
  ops.forEach((o, i) => {
    const src = firm.bankB[i];
    assert.equal(o.amount, src.amount);
    assert.equal(o.direction, src.direction);
    assert.equal(o.inn, src.inn);
    assert.equal(o.name, src.name);
    assert.equal(o.purpose, src.purpose);
    assert.equal(o.date, src.date);
  });
});
