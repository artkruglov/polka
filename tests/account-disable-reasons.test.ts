// Migration 072 on data as production had it (docs/specs/EXTENSIONS.md):
// an account disabled by its deletion request is not the operator's, one the
// operator disabled is, an active one has no reason; and the CHECK keeps an
// account disabled while a reason holds. The table goes back to its shape
// before 072 inside a transaction that is rolled back.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { db } from "../apps/server/db.ts";
import { migrationFileUrl } from "../packages/migrations.ts";

after(() => db.end());

test("072 records the operator's disables, not the deletion requests'", async () => {
  const sql = await readFile(migrationFileUrl("072_account_disable_reasons.sql"), "utf8");
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    // accounts as before 072.
    await c.query(`ALTER TABLE accounts
      DROP CONSTRAINT accounts_disabled_while_held,
      DROP CONSTRAINT accounts_deprovision_shape,
      DROP COLUMN operator_disabled_at,
      DROP COLUMN deprovisioned_at,
      DROP COLUMN deprovisioned_by`);
    const account = async (label: string, disabled: boolean, deleting: boolean) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO accounts(id,name,password_hash,disabled,deletion_requested_at)
         VALUES($1,$2,'x',$3,CASE WHEN $4 THEN now() END)`,
        [id, `m072-${label}-${id.slice(0, 8)}`, disabled, deleting],
      );
      return id;
    };
    const deleting = await account("deleting", true, true);
    const operator = await account("operator", true, false);
    const active = await account("active", false, false);
    await c.query(sql);
    const reasons = async (id: string) =>
      (
        await c.query(
          `SELECT disabled,operator_disabled_at IS NOT NULL AS operator,deprovisioned_at IS NOT NULL AS deprovisioned
           FROM accounts WHERE id=$1`,
          [id],
        )
      ).rows[0];
    assert.deepEqual(await reasons(deleting), { disabled: true, operator: false, deprovisioned: false });
    assert.deepEqual(await reasons(operator), { disabled: true, operator: true, deprovisioned: false });
    assert.deepEqual(await reasons(active), { disabled: false, operator: false, deprovisioned: false });
    // The CHECK: no reason may hold on an enabled account.
    await c.query("SAVEPOINT held");
    await assert.rejects(
      c.query("UPDATE accounts SET disabled=false WHERE id=$1", [operator]),
      /accounts_disabled_while_held/,
    );
    await c.query("ROLLBACK TO SAVEPOINT held");
    await assert.rejects(
      c.query("UPDATE accounts SET deprovisioned_at=now(),deprovisioned_by='sso' WHERE id=$1", [active]),
      /accounts_disabled_while_held/,
    );
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});
