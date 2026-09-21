import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  validateCapture,
  validateSuccessfulReceipts,
} from "../scripts/capture-via-mcp.ts";

const ids = {
  uploadId: "11111111-1111-4111-8111-111111111111",
  artifactId: "22222222-2222-4222-8222-222222222222",
  revisionId: "33333333-3333-4333-8333-333333333333",
};
const hash = "a".repeat(64);

function receipt() {
  return {
    ...ids,
    number: 1,
    sha256: hash,
    htmlProfile: "unsupported",
    manifestSha256: hash,
    storageKind: "bundle",
    totalSize: 7,
  };
}

test("receipt validation rejects malformed and mismatched status", () => {
  const capture = receipt();
  const status = {
    uploadId: capture.uploadId,
    state: "saved",
    receipt: capture,
  };
  assert.deepEqual(
    validateSuccessfulReceipts(capture, status).captureReceipt,
    capture,
  );
  assert.throws(() =>
    validateSuccessfulReceipts(capture, {
      ...status,
      receipt: { ...capture, revisionId: ids.artifactId },
    }),
  );
  assert.throws(() =>
    validateSuccessfulReceipts(capture, {
      uploadId: capture.uploadId,
      state: "pending",
      receipt: null,
    }),
  );
  assert.throws(() =>
    validateSuccessfulReceipts({ ...capture, sha256: "not-a-hash" }, status),
  );
});

test("capture validation preserves exact encoded bytes and capturedAt", () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
  const encoded = bytes.toString("base64");
  const capturedAt = "2026-09-20T12:34:56.789+03:00";
  const request = {
    key: "44444444-4444-4444-8444-444444444444",
    title: "Exact bytes",
    manifest: {
      version: 1,
      entrypoint: "index.html",
      runtime: "preserved-only-v1",
      files: [
        {
          path: "index.html",
          mime: "text/html",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
      provenance: {
        kind: "mcp",
        sourceUrl: null,
        capturedAt,
        attribution: "test",
        license: "unknown",
      },
      dependencies: { status: "unknown", unresolved: [] },
    },
    files: [{ path: "index.html", encoding: "base64", data: encoded }],
  };
  const validated = validateCapture(request);
  assert.equal(validated.files[0].data, encoded);
  assert.equal(validated.manifest.provenance.capturedAt, capturedAt);
  assert.equal(
    validated.manifest.files[0].sha256,
    request.manifest.files[0].sha256,
  );

  const secondBytes = Buffer.from("second");
  const duplicateManifest = {
    ...request.manifest,
    files: [
      ...request.manifest.files,
      {
        path: "notes.txt",
        mime: "text/plain",
        size: secondBytes.length,
        sha256: createHash("sha256").update(secondBytes).digest("hex"),
      },
    ],
  };
  assert.throws(() =>
    validateCapture({
      ...request,
      manifest: duplicateManifest,
      files: [request.files[0], request.files[0]],
    }),
  );
});
