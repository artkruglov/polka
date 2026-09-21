import {
  runImportOnce,
  expireImportJobs,
} from "../apps/server/url-import/worker.ts";
import { captureHtmlUrl } from "../apps/server/url-import/html-capture.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createAccount } from "../apps/server/auth.ts";
import { db } from "../apps/server/db.ts";
import {
  createImportJob,
  getImportJob,
  importJobView,
  cancelImportJob,
  claimImportJob,
  requireImportLease,
} from "../apps/server/url-import/jobs.ts";
after(() => db.end());
test("durable URL jobs isolate owners, deduplicate requests, fence stale workers and cancel", async () => {
  const owner = await createAccount(
    "job-" + randomBytes(5).toString("hex"),
    randomBytes(24).toString("hex"),
  );
  const other = await createAccount(
    "job-" + randomBytes(5).toString("hex"),
    randomBytes(24).toString("hex"),
  );
  const c = await db.connect();
  const schema = "test_import_" + randomBytes(8).toString("hex");
  try {
    await c.query("BEGIN");
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET LOCAL search_path TO ${schema},public`);
    await c.query(
      await readFile(
        new URL(
          "../deploy/migrations/019_url_import_jobs.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const input = {
      key: randomUUID(),
      url: "https://example.org/report?private=value",
    };
    const first = await createImportJob(c, owner, input);
    assert.equal(first.state, "queued");
    assert.deepEqual(await createImportJob(c, owner, input), first);
    assert.equal(JSON.stringify(first).includes("private"), false);
    await assert.rejects(
      createImportJob(c, owner, {
        ...input,
        url: "https://example.org/different",
      }),
      { status: 409 },
    );
    await assert.rejects(getImportJob(c, other, first.id), { status: 404 });
    const claim = await claimImportJob(c);
    assert.equal(claim.id, first.id);
    assert.equal(await claimImportJob(c), null);
    await c.query(
      "UPDATE url_import_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    const next = await claimImportJob(c);
    assert.notEqual(next.lease_token, claim.lease_token);
    await assert.rejects(requireImportLease(c, first.id, claim.lease_token), {
      status: 409,
    });
    assert.equal(
      (await requireImportLease(c, first.id, next.lease_token)).id,
      first.id,
    );
    const cancelled = await cancelImportJob(c, owner, first.id);
    assert.equal(cancelled.state, "cancelled");
    await assert.rejects(requireImportLease(c, first.id, next.lease_token), {
      status: 409,
    });
    assert.deepEqual(
      importJobView(await getImportJob(c, owner, first.id)),
      cancelled,
    );
    assert.equal(await claimImportJob(c), null);
    const run = async <T>(fn: (client: typeof c) => Promise<T>) => fn(c);
    const prepared = await captureHtmlUrl("https://example.org/report", {
      fetcher: async (url) => ({
        url,
        contentType: "text/html",
        bytes: Buffer.from("<h1>Saved report</h1>"),
      }),
    });
    let persisted = 0;
    const persist = async (_actor: unknown, _body: unknown, hooks: any) => {
      await hooks.beforeStep(c);
      persisted++;
      const receipt = { artifactId: randomUUID(), revisionId: randomUUID() };
      await hooks.afterSave(c, receipt);
      return receipt;
    };
    const success = await createImportJob(c, owner, {
      key: randomUUID(),
      url: "https://example.org/one",
    });
    assert.equal(
      await runImportOnce({ run, prepare: async () => prepared, persist }),
      true,
    );
    const ready = await getImportJob(c, owner, success.id);
    assert.equal(ready.state, "partial");
    assert.equal(ready.prepared, null);
    assert.ok(ready.receipt);
    const resumed = await createImportJob(c, owner, {
      key: randomUUID(),
      url: "https://example.org/two",
    });
    await c.query(
      "UPDATE url_import_jobs SET prepared=$2,state='prepared' WHERE id=$1",
      [resumed.id, prepared],
    );
    await runImportOnce({
      run,
      prepare: async () => {
        throw Error("must not download a new source on recovery");
      },
      persist,
    });
    assert.equal((await getImportJob(c, owner, resumed.id)).state, "partial");
    assert.equal(persisted, 2);
    const duringFetch = await createImportJob(c, owner, {
      key: randomUUID(),
      url: "https://example.org/three",
    });
    await runImportOnce({
      run,
      prepare: async () => {
        await cancelImportJob(c, owner, duringFetch.id);
        return prepared;
      },
      persist,
    });
    assert.equal(
      (await getImportJob(c, owner, duringFetch.id)).state,
      "cancelled",
    );
    assert.equal(persisted, 2);
    const exhausted = await createImportJob(c, owner, {
      key: randomUUID(),
      url: "https://example.org/four",
    });
    await c.query("UPDATE url_import_jobs SET attempts=3 WHERE id=$1", [
      exhausted.id,
    ]);
    assert.equal(await expireImportJobs(run), 1);
    assert.equal(
      (await getImportJob(c, owner, exhausted.id)).error_code,
      "retry_exhausted",
    );
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});
