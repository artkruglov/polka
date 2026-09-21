import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDatabaseHealthAdapter,
  createStorageHealthAdapter,
} from "../apps/server/health-adapters.ts";
import {
  READINESS_BYTES,
  READINESS_KEY,
} from "../packages/storage/readiness.ts";

const databaseConfig = {
  databaseUrl: "postgres://health:test@127.0.0.1/polka",
  expectedMigrations: [1, 2, 3],
};
const storageConfig = {
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  accessKey: "health",
  secretKey: "health-secret",
  bucket: "polka",
};
const commandName = (command: unknown) =>
  (command as { constructor: { name: string } }).constructor.name;

test("database adapter uses a bounded dedicated pool and exact migration set", async () => {
  let options: Record<string, unknown> | undefined;
  let released = false;
  let errorListener = false;
  const adapter = createDatabaseHealthAdapter(databaseConfig, {
    createPool(received) {
      options = received;
      return {
        async connect() {
          return {
            async query(query) {
              assert.notEqual((query as { signal?: AbortSignal }).signal?.aborted, true);
              return { rows: [{ version: "1" }, { version: 2 }, { version: 3 }] };
            },
            release() {
              released = true;
            },
          };
        },
        async end() {},
        on(event) {
          assert.equal(event, "error");
          errorListener = true;
        },
      };
    },
  });
  assert.equal(await adapter.probe(new AbortController().signal), true);
  assert.deepEqual(options, {
    connectionString: databaseConfig.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
  });
  assert.equal(released, true);
  assert.equal(errorListener, true);
  await adapter.close();
});

test("database adapter rejects a missing, extra, or duplicated migration", async () => {
  for (const rows of [
    [{ version: 1 }, { version: 2 }],
    [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }],
    [{ version: 1 }, { version: 2 }, { version: 2 }],
  ]) {
    const adapter = createDatabaseHealthAdapter(databaseConfig, {
      createPool: () => ({
        connect: async () => ({ query: async () => ({ rows }), release() {} }),
        end: async () => {},
      }),
    });
    assert.equal(await adapter.probe(new AbortController().signal), false);
    await adapter.close();
  }
});

test("database adapter returns false on an aborted probe and closes the pool", async () => {
  let ended = false;
  let destroyed = false;
  let queryStarted = false;
  const adapter = createDatabaseHealthAdapter(databaseConfig, {
    createPool: () => ({
      connect: async () => ({
        query: async (query) => {
          queryStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { rows: [] };
        },
        release(force) {
          destroyed ||= force === true;
        },
      }),
      end: async () => {
        ended = true;
      },
      on() {},
    }),
  });
  const controller = new AbortController();
  const pending = adapter.probe(controller.signal);
  while (!queryStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  assert.equal(await pending, false);
  await adapter.close();
  assert.equal(ended, true);
  assert.equal(destroyed, true);
});

function objectStream(bytes: Uint8Array, onDestroy?: () => void) {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
    destroy: onDestroy,
  };
}

test("storage adapter requires versioning and reads the exact known canary version", async () => {
  const seen: Array<{ key?: string; version?: string }> = [];
  let destroyed = false;
  const adapter = createStorageHealthAdapter(storageConfig, {
    createClient(options) {
      assert.equal(options.maxAttempts, 1);
      return {
        async send(command) {
          const input = (command as { input: { Key?: string; VersionId?: string } }).input;
          if (commandName(command) === "GetBucketVersioningCommand")
            return { Status: "Enabled" };
          seen.push({ key: input.Key, version: input.VersionId });
          return {
            VersionId: input.VersionId ?? "version-1",
            Body: objectStream(READINESS_BYTES),
          };
        },
        destroy() {
          destroyed = true;
        },
      };
    },
  });
  assert.equal(await adapter.probe(new AbortController().signal), true);
  assert.deepEqual(seen, [
    { key: READINESS_KEY, version: undefined },
    { key: READINESS_KEY, version: "version-1" },
  ]);
  await adapter.close();
  assert.equal(destroyed, true);
});

test("storage adapter rejects disabled versioning, wrong bytes, missing version, and oversized bodies", async () => {
  const cases: Array<{
    versioning: string;
    version?: string | null;
    body: Uint8Array;
  }> = [
    { versioning: "Suspended", version: "version-1", body: READINESS_BYTES },
    { versioning: "Enabled", version: "version-1", body: Buffer.from("wrong") },
    { versioning: "Enabled", version: "null", body: READINESS_BYTES },
    {
      versioning: "Enabled",
      version: "version-1",
      body: Buffer.alloc(257, 1),
    },
  ];
  for (const current of cases) {
    let destroyed = false;
    const adapter = createStorageHealthAdapter(storageConfig, {
      createClient: () => ({
        async send(command) {
          if (commandName(command) === "GetBucketVersioningCommand")
            return { Status: current.versioning };
          return {
            VersionId: current.version,
            Body: objectStream(current.body, () => {
              destroyed = true;
            }),
          };
        },
        destroy() {},
      }),
    });
    assert.equal(await adapter.probe(new AbortController().signal), false);
    if (current.body.length > 256) assert.equal(destroyed, true);
    await adapter.close();
  }
});

test("storage adapter disposes bodies when versions are invalid or do not match", async () => {
  for (const mode of ["missing", "mismatch"] as const) {
    let destroyed = false;
    const adapter = createStorageHealthAdapter(storageConfig, {
      createClient: () => ({
        async send(command) {
          if (commandName(command) === "GetBucketVersioningCommand")
            return { Status: "Enabled" };
          const input = (command as { input: { VersionId?: string } }).input;
          return {
            VersionId: mode === "missing" ? null : input.VersionId ? "other" : "version-1",
            Body: objectStream(READINESS_BYTES, () => {
              destroyed = true;
            }),
          };
        },
        destroy() {},
      }),
    });
    assert.equal(await adapter.probe(new AbortController().signal), false);
    assert.equal(destroyed, true);
    await adapter.close();
  }
});

test("storage adapter aborts and destroys an overlong canary stream", async () => {
  let destroyed = false;
  const adapter = createStorageHealthAdapter(storageConfig, {
    createClient: () => ({
      async send(command) {
        if (commandName(command) === "GetBucketVersioningCommand")
          return { Status: "Enabled" };
        return {
          VersionId: "version-1",
          Body: {
            async *[Symbol.asyncIterator]() {
              yield READINESS_BYTES;
              await new Promise((resolve) => setTimeout(resolve, 20));
              yield Buffer.from("late");
            },
            destroy() {
              destroyed = true;
            },
          },
        };
      },
      destroy() {},
    }),
  });
  const controller = new AbortController();
  const pending = adapter.probe(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(destroyed, true);
  await adapter.close();
});

test("storage adapter disposes a body returned after an already-aborted request", async () => {
  const controller = new AbortController();
  let destroyed = false;
  const adapter = createStorageHealthAdapter(storageConfig, {
    createClient: () => ({
      async send(command) {
        if (commandName(command) === "GetBucketVersioningCommand")
          return { Status: "Enabled" };
        controller.abort();
        return {
          VersionId: "version-1",
          Body: objectStream(READINESS_BYTES, () => {
            destroyed = true;
          }),
        };
      },
      destroy() {},
    }),
  });
  assert.equal(await adapter.probe(controller.signal), false);
  assert.equal(destroyed, true);
  await adapter.close();
});
