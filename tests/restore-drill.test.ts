import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  assertDrillIdentity,
  assertPlainLoopbackUrl,
  assertSeparatedIdentities,
  bucketName,
  databaseName,
  decryptSecret,
  encryptSecret,
} from "../scripts/restore-drill-lib.ts";

test("restore drill identities require exact synthetic prefixes and separation", () => {
  const id = "20260920abc123";
  const sourceDatabase = databaseName(id, "source");
  const targetDatabase = databaseName(id, "target");
  const sourceBucket = bucketName(id, "source");
  const targetBucket = bucketName(id, "target");
  assert.doesNotThrow(() =>
    assertDrillIdentity(id, "source", sourceDatabase, sourceBucket),
  );
  assert.doesNotThrow(() =>
    assertDrillIdentity(id, "target", targetDatabase, targetBucket),
  );
  assert.doesNotThrow(() =>
    assertSeparatedIdentities({
      workingDatabase: "polka",
      sourceDatabase,
      targetDatabase,
      workingBucket: "polka-local",
      sourceBucket,
      targetBucket,
      sourceEndpoint: "http://127.0.0.1:9038",
      targetEndpoint: "http://127.0.0.1:9038",
    }),
  );
  assert.throws(() => assertDrillIdentity(id, "source", "polka", sourceBucket));
  assert.throws(() =>
    assertSeparatedIdentities({
      workingDatabase: "polka",
      sourceDatabase: "polka",
      targetDatabase,
      workingBucket: "polka-local",
      sourceBucket,
      targetBucket,
      sourceEndpoint: "http://127.0.0.1:9038",
      targetEndpoint: "http://127.0.0.1:9038",
    }),
  );
});

test("restore drill rejects URL query routing overrides before writes", () => {
  assert.doesNotThrow(() =>
    assertPlainLoopbackUrl(
      new URL("postgresql://polka@127.0.0.1:54388/polka"),
      "database",
    ),
  );
  assert.throws(() =>
    assertPlainLoopbackUrl(
      new URL("postgresql://localuser@127.0.0.1:5432/polka?host=example.test"),
      "database",
    ),
  );
  assert.throws(() =>
    assertPlainLoopbackUrl(
      new URL("http://127.0.0.1:9038?endpoint=example.test"),
      "S3",
    ),
  );
});

test("restore drill secret escrow is authenticated and never stores plaintext", () => {
  const secret = randomBytes(64).toString("base64url");
  const key = randomBytes(32);
  const encrypted = encryptSecret(secret, key);
  assert.equal(encrypted.includes(Buffer.from(secret)), false);
  assert.equal(decryptSecret(encrypted, key), secret);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptSecret(encrypted, key));
});
