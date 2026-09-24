import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { cleanupEmailChallengesInTransaction } from "../apps/server/email-maintenance.ts";
import {
  runMaintenanceCli,
  runMaintenanceOnce,
} from "../scripts/maintenance-cli.ts";
import {
  createMaintenanceDatabase,
  type MaintenanceDatabase,
} from "../scripts/maintenance-adapters.ts";
import type {
  MaintenanceObjectPage,
  MaintenanceObjectStore,
} from "../scripts/maintenance-cleanup.ts";

type Fixture = {
  tenantId: string;
  uploadId: string;
  derivativeId: string;
  attemptId: string;
};

class FakeDatabase extends EventEmitter implements MaintenanceDatabase {
  readonly calls: string[] = [];
  readonly fixture: Fixture;
  destroyed = false;
  connected = false;
  constructor(
    private readonly options: {
      locked?: boolean;
      upload?: boolean;
      derivative?: boolean;
      referenced?: boolean;
    } = {},
  ) {
    super();
    this.fixture = {
      tenantId: randomUUID(),
      uploadId: randomUUID(),
      derivativeId: randomUUID(),
      attemptId: randomUUID(),
    };
  }
  async connect() {
    this.connected = true;
  }
  async query(sql: string) {
    this.calls.push(sql);
    if (sql.includes("pg_try_advisory_lock"))
      return { rows: [{ locked: this.options.locked ?? true }] };
    if (sql.includes("SELECT id,tenant_id FROM uploads"))
      return {
        rows:
          this.options.upload === false
            ? []
            : [
                {
                  id: this.fixture.uploadId,
                  tenant_id: this.fixture.tenantId,
                },
              ],
      };
    if (sql.includes("SELECT * FROM uploads"))
      return {
        rows: [
          {
            id: this.fixture.uploadId,
            tenant_id: this.fixture.tenantId,
            kind: "single",
            request: {},
          },
        ],
      };
    if (sql.includes("SELECT object_key FROM revisions"))
      return { rows: this.options.referenced ? [{ object_key: "held" }] : [] };
    if (sql.includes("SELECT id,tenant_id FROM revision_derivatives"))
      return {
        rows: this.options.derivative
          ? [
              {
                id: this.fixture.derivativeId,
                tenant_id: this.fixture.tenantId,
              },
            ]
          : [],
      };
    if (sql.includes("SELECT * FROM revision_derivatives"))
      return {
        rows: [
          {
            id: this.fixture.derivativeId,
            tenant_id: this.fixture.tenantId,
            attempt_id: this.fixture.attemptId,
          },
        ],
      };
    if (sql.includes("SELECT id,delivery FROM login_challenges"))
      return { rows: [] };
    return { rows: [] };
  }
  release(force?: boolean) {
    this.destroyed ||= force === true;
  }
  async end() {
    this.destroyed = true;
  }
}

function versionPage(
  versions: Array<{ key: string; versionId: string }>,
): MaintenanceObjectPage {
  return {
    versions,
    deleteMarkers: [],
    truncated: false,
  };
}

function store(options: {
  versions?: (prefix: string) => Array<{ key: string; versionId: string }>;
  onDelete?: (key: string, versionId: string) => void | Promise<void>;
}) {
  const listed: string[] = [];
  const deleted: Array<{ key: string; versionId: string }> = [];
  const storage: MaintenanceObjectStore = {
    async listVersions(input, signal) {
      assert.equal(signal.aborted, false);
      listed.push(input.prefix);
      return versionPage(options.versions?.(input.prefix) ?? []);
    },
    async deleteVersion(key, versionId, signal) {
      assert.equal(signal.aborted, false);
      deleted.push({ key, versionId });
      await options.onDelete?.(key, versionId);
    },
  };
  return { storage, listed, deleted };
}

test("one guarded run reconciles exact upload and derivative versions before committed counters", async () => {
  const database = new FakeDatabase({ derivative: true });
  const uploadKey = `${database.fixture.tenantId}/${database.fixture.uploadId}`;
  const derivativeKey = `${database.fixture.tenantId}/derivatives/${database.fixture.derivativeId}/${database.fixture.attemptId}.html`;
  const objects = store({
    versions: (prefix) => [{ key: prefix, versionId: `${prefix}-version` }],
  });
  const result = await runMaintenanceOnce({
    database,
    storage: objects.storage,
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, {
    state: "completed",
    value: {
      expiredUploadsReconciled: 1,
      expiredDerivativesReconciled: 1,
      emailChallengesRemoved: 0,
    },
  });
  assert.deepEqual(objects.listed, [uploadKey, derivativeKey]);
  assert.deepEqual(objects.deleted, [
    { key: uploadKey, versionId: `${uploadKey}-version` },
    { key: derivativeKey, versionId: `${derivativeKey}-version` },
  ]);
  const uploadUpdate = database.calls.findIndex((sql) =>
    sql.includes("UPDATE uploads"),
  );
  const derivativeUpdate = database.calls.findIndex((sql) =>
    sql.includes("UPDATE revision_derivatives"),
  );
  assert.ok(uploadUpdate > -1 && derivativeUpdate > uploadUpdate);
  assert.equal(database.calls.filter((sql) => sql === "COMMIT").length, 5);
  // The privacy policy keeps a report for one year.
  assert.ok(
    database.calls.includes(
      "DELETE FROM share_reports WHERE created_at<now()-interval '1 year'",
    ),
  );
  assert.ok(
    database.calls.includes(
      "DELETE FROM enterprise_requests WHERE created_at<now()-interval '1 year'",
    ),
  );
  // Usage analytics: raw events and active days for 13 months, and those of
  // deleted accounts (the fake database has none); the counters stay.
  for (const sql of [
    "DELETE FROM analytics_events WHERE occurred_at<now()-interval '13 months'",
    "DELETE FROM analytics_active_days WHERE day<(now()-interval '13 months')::date",
    "SELECT id FROM accounts WHERE deletion_requested_at IS NOT NULL",
  ])
    assert.ok(database.calls.includes(sql), sql);
  assert.ok(!database.calls.some((sql) => sql.includes("analytics_daily")));
});

test("abort after one exact delete rolls back metadata and a later run finishes reconciliation", async () => {
  const controller = new AbortController();
  const firstDatabase = new FakeDatabase({ derivative: false });
  const key = `${firstDatabase.fixture.tenantId}/${firstDatabase.fixture.uploadId}`;
  const first = store({
    versions: () => [
      { key, versionId: "version-one" },
      { key, versionId: "version-two" },
    ],
    onDelete: () => controller.abort(),
  });
  const stopped = await runMaintenanceOnce({
    database: firstDatabase,
    storage: first.storage,
    signal: controller.signal,
  });
  assert.deepEqual(stopped, { state: "aborted" });
  assert.deepEqual(first.deleted, [{ key, versionId: "version-one" }]);
  assert.equal(
    firstDatabase.calls.some((sql) => sql.includes("UPDATE uploads")),
    false,
  );
  assert.equal(firstDatabase.calls.includes("ROLLBACK"), true);

  const retryDatabase = new FakeDatabase({ derivative: false });
  retryDatabase.fixture.tenantId = firstDatabase.fixture.tenantId;
  retryDatabase.fixture.uploadId = firstDatabase.fixture.uploadId;
  const retry = store({
    versions: () => [{ key, versionId: "version-two" }],
  });
  const completed = await runMaintenanceOnce({
    database: retryDatabase,
    storage: retry.storage,
    signal: new AbortController().signal,
  });
  assert.equal(completed.state, "completed");
  assert.deepEqual(retry.deleted, [{ key, versionId: "version-two" }]);
  assert.equal(
    retryDatabase.calls.some((sql) => sql.includes("UPDATE uploads")),
    true,
  );
});

test("committed object references fail closed without storage deletion", async () => {
  const database = new FakeDatabase({ referenced: true, derivative: false });
  const objects = store({
    versions: () => {
      throw new Error("storage must not be reached");
    },
  });
  const result = await runMaintenanceOnce({
    database,
    storage: objects.storage,
    signal: new AbortController().signal,
  });
  assert.equal(result.state, "failed");
  assert.deepEqual(objects.listed, []);
  assert.deepEqual(objects.deleted, []);
  assert.equal(
    database.calls.some((sql) => sql.includes("UPDATE uploads")),
    false,
  );
});

test("a second singleton run skips without touching storage", async () => {
  let releaseListing!: () => void;
  const listingReleased = new Promise<void>((resolve) => {
    releaseListing = resolve;
  });
  let listingStarted!: () => void;
  const listing = new Promise<void>((resolve) => {
    listingStarted = resolve;
  });
  const firstDatabase = new FakeDatabase({ derivative: false });
  const firstStore = store({});
  firstStore.storage.listVersions = async () => {
    listingStarted();
    await listingReleased;
    return versionPage([]);
  };
  const first = runMaintenanceOnce({
    database: firstDatabase,
    storage: firstStore.storage,
    signal: new AbortController().signal,
  });
  await listing;

  const secondDatabase = new FakeDatabase({ locked: false });
  const secondStore = store({
    versions: () => {
      throw new Error("busy run must not list storage");
    },
  });
  const second = await runMaintenanceOnce({
    database: secondDatabase,
    storage: secondStore.storage,
    signal: new AbortController().signal,
  });
  assert.deepEqual(second, { state: "busy" });
  assert.deepEqual(secondStore.listed, []);
  releaseListing();
  assert.equal((await first).state, "completed");
});

test("email transaction checks cancellation after unlink and before metadata delete", async () => {
  const controller = new AbortController();
  const sql: string[] = [];
  await assert.rejects(
    cleanupEmailChallengesInTransaction(
      {
        async query(statement) {
          sql.push(statement);
          if (statement.includes("SELECT id,delivery"))
            return { rows: [{ id: randomUUID(), delivery: "local" }] };
          return { rows: [] };
        },
      },
      100,
      () => {
        if (controller.signal.aborted) throw new Error("stopped");
      },
      async () => {
        controller.abort();
      },
    ),
    /stopped/,
  );
  assert.equal(
    sql.some((statement) => statement.includes("DELETE FROM")),
    false,
  );
});

test("guard loss after one delete prevents metadata updates and further object work", async () => {
  const database = new FakeDatabase({ derivative: false });
  const key = `${database.fixture.tenantId}/${database.fixture.uploadId}`;
  let deletes = 0;
  const objects = store({
    versions: () => [
      { key, versionId: "first" },
      { key, versionId: "second" },
    ],
    onDelete: () => {
      deletes++;
      database.emit("error", new Error("guard connection lost"));
    },
  });
  const result = await runMaintenanceOnce({
    database,
    storage: objects.storage,
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { state: "guard_lost" });
  assert.equal(deletes, 1);
  assert.equal(
    database.calls.some((sql) => sql.includes("UPDATE uploads")),
    false,
  );
  assert.equal(database.calls.at(-1), "ROLLBACK");
});

test("missing object VersionId fails before delete or reconciliation commit", async () => {
  const database = new FakeDatabase({ derivative: false });
  const key = `${database.fixture.tenantId}/${database.fixture.uploadId}`;
  const objects = store({});
  objects.storage.listVersions = async () =>
    versionPage([{ key, versionId: "null" }]);
  const result = await runMaintenanceOnce({
    database,
    storage: objects.storage,
    signal: new AbortController().signal,
  });
  assert.equal(result.state, "failed");
  assert.deepEqual(objects.deleted, []);
  assert.equal(
    database.calls.some((sql) => sql.includes("UPDATE uploads")),
    false,
  );
});

test("database query timeout closes the dedicated client instead of allowing reuse", async () => {
  const events = new EventEmitter();
  let ended = 0;
  const database = createMaintenanceDatabase("postgres://unused", {
    queryTimeoutMs: 5,
    createClient: () => ({
      async connect() {},
      async query() {
        await new Promise(() => undefined);
        return { rows: [] };
      },
      on(event, listener) {
        events.on(event, listener);
      },
      off(event, listener) {
        events.off(event, listener);
      },
      async end() {
        ended++;
      },
    }),
  });
  await database.connect();
  await assert.rejects(database.query("SELECT deferred"), /timed out/);
  assert.equal(ended, 1);
  await assert.rejects(database.query("SELECT after timeout"), /closed/);
});

test("database close prevents a deferred query from reaching the raw client", async () => {
  const events = new EventEmitter();
  const queries: string[] = [];
  const database = createMaintenanceDatabase("postgres://unused", {
    createClient: () => ({
      async connect() {},
      async query(sql) {
        queries.push(sql);
        return { rows: [] };
      },
      on(event, listener) {
        events.on(event, listener);
      },
      off(event, listener) {
        events.off(event, listener);
      },
      async end() {},
    }),
  });
  const pending = database.query("COMMIT");
  await database.end?.();
  await assert.rejects(pending, /closed/);
  assert.deepEqual(queries, []);
});

test("CLI emits a safe busy outcome and closes storage without cleanup I/O", async () => {
  const database = new FakeDatabase({ locked: false });
  const events: Array<Record<string, unknown>> = [];
  let storageClosed = false;
  const objects = store({
    versions: () => {
      throw new Error("busy CLI must not access storage");
    },
  });
  const exitCode = await runMaintenanceCli({
    createDatabase: () => database,
    createStorage: () => ({
      ...objects.storage,
      close() {
        storageClosed = true;
      },
    }),
    emit: (event) => events.push(event),
    deadlineMs: 1000,
    signal: new AbortController().signal,
  });
  assert.equal(exitCode, 0);
  assert.equal(storageClosed, true);
  assert.deepEqual(
    events.map((event) => event.event),
    ["maintenance.started", "maintenance.skipped"],
  );
  assert.equal(events[1].reason, "busy");
  assert.deepEqual(objects.listed, []);
});

test("CLI bounds a hanging setup close and still disposes storage", async () => {
  const database = new FakeDatabase();
  database.connect = async () => {
    throw new Error("connect failed");
  };
  database.end = async () => new Promise<void>(() => undefined);
  let storageClosed = false;
  const startedAt = performance.now();
  const exitCode = await runMaintenanceCli({
    createDatabase: () => database,
    createStorage: () => ({
      ...store({}).storage,
      close() {
        storageClosed = true;
      },
    }),
    emit: () => undefined,
    deadlineMs: 2_000,
    signal: new AbortController().signal,
  });
  assert.equal(exitCode, 1);
  assert.equal(storageClosed, true);
  assert.ok(performance.now() - startedAt < 1_500);
});
