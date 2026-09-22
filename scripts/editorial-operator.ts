import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Actor } from "../apps/server/artifacts.ts";
import {
  editorialPublishSchema,
  publishEditorial,
} from "../apps/server/editorial.ts";
import { sha256 } from "../apps/server/storage.ts";

/**
 * The operator publication path shared by editorial-publish.ts and
 * editorial-seed-hosted.ts: the manifest must name the expected tenant and a
 * committed source under content/editorial whose bytes still match its hash.
 */
export async function publishEditorialOperatorInput(
  owner: Actor,
  body: unknown,
) {
  const input = editorialPublishSchema.parse(body);
  if (input.manifest.binding.tenantId !== owner.tenant)
    throw new Error("Expected tenant does not match the manifest");
  if (!input.manifest.source.path.startsWith("content/editorial/"))
    throw new Error("Editorial source must be inside content/editorial");
  const source = await readFile(resolve(input.manifest.source.path));
  if (sha256(source) !== input.manifest.source.sha256)
    throw new Error("Editorial source hash mismatch");
  return publishEditorial(owner, input);
}
