// What an extension may read of a saved version (docs/specs/EXTENSIONS.md,
// context.content): the work, its shelf, the version and its files, and each
// file's bytes as a stream. Moderation and checksums stay the core's: a
// version moderation isolated or deleted is reported, never read, and every
// stream is checked against the version's record of its size and SHA-256.
import { createHash } from "node:crypto";
import { pipeline, Readable, Transform } from "node:stream";
import type { ExtensionRevision } from "../../packages/extension-api/index.ts";
import { db } from "./db.ts";
import { Problem } from "./errors.ts";
import { unavailableSql } from "./revision-availability.ts";
import { readStoredFile, storedRevisionFiles } from "./work-files.ts";

async function revisionRow(tenantId: string, revisionId: string) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT r.*,${unavailableSql("r")} AS unavailable,
            a.title AS artifact_title,a.trashed_at AS artifact_trashed_at,
            a.accepted_revision_id AS artifact_accepted_revision_id,
            t.kind AS shelf_kind,t.name AS shelf_name,
            f.id AS folder_id,f.name AS folder_name
       FROM revisions r
       JOIN artifacts a ON a.id=r.artifact_id AND a.tenant_id=r.tenant_id
       JOIN tenants t ON t.id=r.tenant_id
       LEFT JOIN folders f ON f.id=a.folder_id
      WHERE r.id=$1 AND r.tenant_id=$2 AND a.purged_at IS NULL`,
    [revisionId, tenantId],
  );
  return row ?? null;
}

/** A saved version of a shelf, or null when there is none (or its work was deleted). */
export async function revisionForExtension(
  tenantId: string,
  revisionId: string,
): Promise<ExtensionRevision | null> {
  const row = await revisionRow(tenantId, revisionId);
  if (!row) return null;
  let files: Awaited<ReturnType<typeof storedRevisionFiles>>["files"] = [];
  let entrypoint: string = row.filename;
  let runtime: string | null = null;
  try {
    ({ files, entrypoint, runtime } = await storedRevisionFiles(db, row));
  } catch (error) {
    if (!row.unavailable) throw error;
  }
  return {
    shelf: { id: tenantId, kind: row.shelf_kind, name: row.shelf_name ?? null },
    artifact: {
      id: row.artifact_id,
      title: row.artifact_title,
      folder: row.folder_id ? { id: row.folder_id, name: row.folder_name } : null,
      trashed: !!row.artifact_trashed_at,
      acceptedRevisionId: row.artifact_accepted_revision_id ?? null,
    },
    revision: {
      id: row.id,
      number: row.number,
      createdAt: new Date(row.created_at).toISOString(),
      manifestSha256: row.manifest_sha256 ?? null,
      entrypoint,
      runtime,
    },
    files: files.map(({ path, mime, size, sha256 }, index) => ({ index, path, mime, size, sha256 })),
    unavailable: row.unavailable ?? null,
  };
}

/**
 * Passes the bytes through and fails unless they are exactly the expected
 * file. The last chunk is held back until the hash is checked, so a reader
 * that knows the length never receives a complete body of the wrong bytes.
 */
export function verifyingStream(expected: { size: number; sha256: string }) {
  const hash = createHash("sha256");
  let size = 0;
  let held: Buffer | null = null;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > expected.size) return done(new Error("Revision file is larger than recorded"));
      hash.update(chunk);
      const previous = held;
      held = chunk;
      done(null, previous ?? undefined);
    },
    flush(done) {
      if (size !== expected.size || hash.digest("hex") !== expected.sha256)
        return done(new Error("Revision file checksum mismatch"));
      done(null, held ?? undefined);
    },
  });
}

/** One file of the version as a stream, checked against its record. */
export async function openFileForExtension(
  tenantId: string,
  revisionId: string,
  index: number,
): Promise<Readable> {
  const row = await revisionRow(tenantId, revisionId);
  if (!row) throw new Problem(404, "not_found", "Нет такой версии.");
  if (row.unavailable)
    throw new Problem(410, "expired", "Эта версия заблокирована модератором и не читается.");
  const file = (await storedRevisionFiles(db, row)).files[index];
  if (!file) throw new Problem(404, "not_found", "Нет такого файла в версии.");
  const read = await readStoredFile(file);
  if ("bytes" in read) return Readable.from([read.bytes]);
  // pipeline: an error on either side reaches the other, and the store's
  // socket closes when the consumer stops reading.
  return pipeline(read.stream, verifyingStream(file), () => {});
}
