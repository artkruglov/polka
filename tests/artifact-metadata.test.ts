import { test } from "node:test";
import assert from "node:assert/strict";
import { updateArtifactMetadataSchema } from "../packages/contracts/index.ts";

const base = {
  expectedTitle: "Current title",
  expectedFolderId: null,
};

test("artifact metadata rename keeps the upload-compatible 160 character limit", () => {
  assert.equal(
    updateArtifactMetadataSchema.safeParse({
      ...base,
      title: "x".repeat(160),
    }).success,
    true,
  );
  assert.equal(
    updateArtifactMetadataSchema.safeParse({
      ...base,
      title: "x".repeat(161),
    }).success,
    false,
  );
  assert.equal(
    updateArtifactMetadataSchema.safeParse({
      ...base,
      expectedTitle: "x".repeat(200),
      folderId: null,
    }).success,
    true,
  );
});
