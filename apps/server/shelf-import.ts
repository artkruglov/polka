// A shelf exported from another installation (polka-export.mjs), saved onto a
// personal shelf here (docs/specs/SHELF_TRANSFER.md). Each version goes through
// the same save path as any upload: the content filter, the quota, the limits
// and search see it like a new save. Then its date, the accepted version, the
// person responsible, the card and the trash are put back as they were.
//
// Rerunnable: each version's upload key is derived from the export's id and
// the source version's id, and a saved upload keeps its receipt, so a second
// run finds what the first one saved and continues after it.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { z } from "zod";
import { canonicalizeManifest } from "../../packages/contracts/bundle.ts";
import { beginUploadSchema, isVideoMime } from "../../packages/contracts/index.ts";
import {
  shelfExportFileSchema,
  type ShelfExportFile,
  type ShelfExportItem,
  type ShelfExportRevision,
} from "../../packages/contracts/shelf-export.ts";
import { findMergeAccount } from "./account-merge.ts";
import {
  audit,
  beginBundleUploadInTransaction,
  beginUploadInTransaction,
  finalizeBundleUploadInTransaction,
  finalizeUploadInTransaction,
  normalizeBundleRequest,
  prepareBundleFinalize,
  prepareUploadFinalize,
  stageBundleFile,
  stageBundleMedia,
  stageUploadBytes,
  uploadBundleFileInTransaction,
  uploadBytesInTransaction,
} from "./artifacts.ts";
import { db, transaction } from "./db.ts";
import { Problem } from "./errors.ts";
import { createFolderInTransaction, MAX_FOLDERS } from "./folders.ts";
import { setShelfCard } from "./shelf-card.ts";
import { lockShelf } from "./shelves.ts";

export class ImportRefusal extends Error {}

/** An upload is retried with the next key when the previous one expired. */
const ATTEMPTS = 5;

type Actor = { id: string; tenant: string };
type Receipt = { artifactId: string; revisionId: string; number: number };

export type ImportReport = {
  dryRun: boolean;
  account: string;
  source: ShelfExportFile["source"];
  works: number;
  versions: number;
  /** Bytes the versions still to save take on the shelf. */
  bytesNeeded: number;
  quota: { used: number; total: number; raisedTo?: number };
  foldersCreated: string[];
  card: "set" | "kept" | "none";
  imported: Array<{
    sourceId: string;
    title: string;
    artifactId: string;
    saved: number;
    already: number;
    /** Versions saved here but isolated by this installation's moderation (the content filter at save). */
    blocked: number[];
  }>;
  skipped: Array<{ sourceId: string; title: string; reason: string }>;
  /** Stopped early (maxRevisions): run again to continue. */
  incomplete: boolean;
};

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** A UUID (v5 layout) for one version's upload: the same export, version and attempt give the same key. */
export function importKey(exportId: string, sourceRevisionId: string, attempt: number) {
  const hex = createHash("sha1").update(`polka-import:${exportId}:${sourceRevisionId}:${attempt}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function blobHash(path: string) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest("hex") };
}

/** Why a work cannot be moved as a whole, or null. */
function unmovable(item: ShelfExportItem) {
  const blocked = item.revisions.find((revision) => revision.unavailable);
  if (blocked)
    return `версия ${blocked.number} заблокирована модератором на исходной установке, её файлы не выгружены`;
  for (const [index, revision] of item.revisions.entries())
    if (revision.number !== index + 1) return "номера версий идут не подряд";
  return null;
}

/** The files of a version as the import sends them, checked against its manifest. */
function versionFiles(revision: ShelfExportRevision) {
  if (revision.storageKind === "single") {
    if (revision.files.length !== 1 || revision.files[0].sha256 !== revision.sha256)
      throw new ImportRefusal(`Версия ${revision.id}: файл не совпадает с описанием.`);
    return revision.files;
  }
  const manifest = canonicalizeManifest(revision.manifest);
  if (sha256(JSON.stringify(manifest)) !== revision.manifestSha256)
    throw new ImportRefusal(`Версия ${revision.id}: манифест не совпадает со своей суммой.`);
  if (
    manifest.files.length !== revision.files.length ||
    manifest.files.some(
      (file, index) =>
        revision.files[index].path !== file.path || revision.files[index].sha256 !== file.sha256 || revision.files[index].size !== file.size,
    )
  )
    throw new ImportRefusal(`Версия ${revision.id}: файлы не совпадают с манифестом.`);
  return revision.files;
}

export async function importShelf(options: {
  dir: string;
  account: string;
  dryRun?: boolean;
  raiseQuota?: boolean;
  replaceCard?: boolean;
  /** Stop after saving this many versions (tests: an interrupted run). */
  maxRevisions?: number;
  progress?: (line: Record<string, unknown>) => void;
}): Promise<ImportReport> {
  const progress = options.progress ?? (() => {});
  // 0. The export, checked whole before anything is written.
  let exported: ShelfExportFile;
  try {
    exported = shelfExportFileSchema.parse(
      JSON.parse(await readFile(join(options.dir, "polka-export.json"), "utf8")),
    );
  } catch (error) {
    throw new ImportRefusal(
      `Не читается ${join(options.dir, "polka-export.json")}: ${error instanceof Error ? error.message.slice(0, 300) : error}`,
    );
  }
  const account = await findMergeAccount(options.account);
  if (!account) throw new ImportRefusal(`Аккаунт ${options.account} не найден.`);
  if (account.disabled || account.deleting || account.provisional)
    throw new ImportRefusal("Аккаунт отключён, удаляется или ещё не подтверждён.");
  // The account's own shelf (one who opened department shelves owns those too).
  const {
    rows: [tenant],
  } = await db.query(
    "SELECT id,state,used_bytes,quota_bytes,video_enabled,card_md FROM tenants WHERE owner_id=$1 AND kind='personal'",
    [account.id],
  );
  if (!tenant || tenant.state !== "active")
    throw new ImportRefusal("Переносить можно только на действующую личную полку.");
  const actor: Actor = { id: account.id, tenant: tenant.id };

  const skipped: ImportReport["skipped"] = [];
  const movable: ShelfExportItem[] = [];
  const blobOk = new Map<string, boolean>();
  for (const item of exported.items) {
    const reason = unmovable(item);
    if (reason) {
      skipped.push({ sourceId: item.id, title: item.title, reason });
      continue;
    }
    // The same request the save will send, so a limit of this installation shows in --dry-run.
    const refused = item.revisions
      .map((revision) => acceptedHere(item, revision))
      .find((problem) => problem);
    if (refused) {
      skipped.push({ sourceId: item.id, title: item.title, reason: refused });
      continue;
    }
    for (const revision of item.revisions)
      for (const file of versionFiles(revision)) {
        if (!blobOk.has(file.sha256)) {
          const found = await blobHash(join(options.dir, "blobs", file.sha256));
          blobOk.set(file.sha256, !!found && found.size === file.size && found.sha256 === file.sha256);
        }
        if (!blobOk.get(file.sha256))
          throw new ImportRefusal(
            `Файл ${file.path} работы «${item.title}» отсутствует или повреждён (blobs/${file.sha256}). Запустите polka-export.mjs ещё раз.`,
          );
      }
    movable.push(item);
  }

  // What earlier runs saved: receipts of uploads with this export's keys.
  const keys = movable.flatMap((item) =>
    item.revisions.flatMap((revision) =>
      Array.from({ length: ATTEMPTS }, (_, attempt) => importKey(exported.exportId, revision.id, attempt)),
    ),
  );
  const { rows: receipts } = await db.query(
    "SELECT idempotency_key,receipt FROM uploads WHERE tenant_id=$1 AND account_id=$2 AND idempotency_key=ANY($3::uuid[]) AND receipt IS NOT NULL",
    [actor.tenant, actor.id, keys],
  );
  const receiptByKey = new Map(receipts.map((row) => [row.idempotency_key as string, row.receipt as Receipt]));
  const savedFor = (revision: ShelfExportRevision) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const receipt = receiptByKey.get(importKey(exported.exportId, revision.id, attempt));
      if (receipt) return receipt;
    }
    return null;
  };

  let bytesNeeded = 0;
  let video = false;
  for (const item of movable)
    for (const revision of item.revisions) {
      if (savedFor(revision)) continue;
      bytesNeeded += revision.totalSize;
      video ||= revision.files.some((file) => isVideoMime(file.mime));
    }
  if (video && !tenant.video_enabled)
    throw new ImportRefusal("В выгрузке есть видео, а на этой полке видео выключено (tenants.video_enabled).");
  const { rows: existingFolders } = await db.query("SELECT id,name FROM folders WHERE tenant_id=$1", [actor.tenant]);
  const folderByName = new Map(existingFolders.map((folder) => [folder.name as string, folder.id as string]));
  const usedFolders = new Set(movable.map((item) => item.folderId).filter(Boolean));
  const folderNames = exported.shelf.folders.filter((folder) => usedFolders.has(folder.id));
  const newFolders = folderNames.filter((folder) => !folderByName.has(folder.name));
  if (folderByName.size + newFolders.length > MAX_FOLDERS)
    throw new ImportRefusal(`На полке будет больше ${MAX_FOLDERS} папок.`);
  // Uploads under way count against the space, as the save itself counts them.
  const {
    rows: [pending],
  } = await db.query(
    `SELECT COALESCE(sum((request->>'size')::bigint),0)::bigint AS size FROM uploads
      WHERE tenant_id=$1 AND receipt IS NULL AND NOT aborted AND expires_at>now()`,
    [actor.tenant],
  );
  const used = Number(tenant.used_bytes) + Number(pending.size);
  const total = Number(tenant.quota_bytes);
  const report: ImportReport = {
    dryRun: !!options.dryRun,
    account: account.email ?? account.name,
    source: exported.source,
    works: movable.length,
    versions: movable.reduce((sum, item) => sum + item.revisions.length, 0),
    bytesNeeded,
    quota: { used, total },
    foldersCreated: newFolders.map((folder) => folder.name),
    card: exported.shelf.cardMd && (!tenant.card_md || options.replaceCard) ? "set" : exported.shelf.cardMd ? "kept" : "none",
    imported: [],
    skipped,
    incomplete: false,
  };
  if (used + bytesNeeded > total && !options.raiseQuota) {
    if (options.dryRun) return report;
    throw new ImportRefusal(
      `Не хватает места: нужно ${bytesNeeded} байт, свободно ${Math.max(0, total - used)}. Добавьте --raise-quota.`,
    );
  }
  if (options.dryRun) return report;

  // 1. The shelf: quota, folders by name, the card.
  if (used + bytesNeeded > total) {
    const raised = used + bytesNeeded;
    await db.query("UPDATE tenants SET quota_bytes=GREATEST(quota_bytes,$2) WHERE id=$1", [actor.tenant, raised]);
    report.quota.raisedTo = raised;
  }
  for (const folder of newFolders) {
    const created = await transaction((c) => createFolderInTransaction(c, actor, folder.name));
    folderByName.set(created.name, created.id);
  }
  const folderFor = new Map(exported.shelf.folders.map((folder) => [folder.id, folderByName.get(folder.name) ?? null]));
  if (report.card === "set") await setShelfCard(actor, { cardMd: exported.shelf.cardMd });

  // 2. The works, each version in order.
  let budget = options.maxRevisions ?? Infinity;
  for (const item of movable) {
    let previous: Receipt | null = null;
    let saved = 0;
    let already = 0;
    try {
      for (const revision of item.revisions) {
        const earlier = savedFor(revision);
        if (earlier) {
          previous = earlier;
          already++;
          continue;
        }
        if (budget <= 0) {
          report.incomplete = true;
          break;
        }
        previous = await saveVersion(actor, join(options.dir, "blobs"), exported.exportId, item, revision, previous, folderFor);
        budget--;
        saved++;
        progress({ event: "version", title: item.title, number: revision.number });
      }
      if (report.incomplete) {
        if (previous)
          report.imported.push({
            sourceId: item.id,
            title: item.title,
            artifactId: previous.artifactId,
            saved,
            already,
            blocked: await blockedVersions(actor, previous.artifactId),
          });
        break;
      }
      // Finished by an earlier run: what the owner changed since stays as it is.
      if (!(await finished(actor, exported.exportId, previous!.artifactId)))
        await finishWork(actor, exported.exportId, item, previous!, folderFor);
      report.imported.push({
        sourceId: item.id,
        title: item.title,
        artifactId: previous!.artifactId,
        saved,
        already,
        blocked: await blockedVersions(actor, previous!.artifactId),
      });
      progress({ event: "work", title: item.title, versions: item.revisions.length });
    } catch (error) {
      // The account was disabled meanwhile (the content filter): nothing more is saved.
      const { rows: [state] } = await db.query("SELECT disabled FROM accounts WHERE id=$1", [actor.id]);
      if (!state || state.disabled) throw error;
      if (!(error instanceof Problem) && !(error instanceof ImportRefusal) && !(error instanceof z.ZodError))
        throw error;
      const message = error instanceof z.ZodError ? refusedFields(error) : error.message;
      const reason =
        saved + already
          ? `сохранено версий ${saved + already} из ${item.revisions.length}, остальные — нет: ${message}`
          : message;
      skipped.push({ sourceId: item.id, title: item.title, reason });
      progress({ event: "skipped", title: item.title, reason });
    }
  }
  return report;
}

/** Saves one version with the next free key; a key whose upload expired is not reused. */
async function saveVersion(
  actor: Actor,
  blobs: string,
  exportId: string,
  item: ShelfExportItem,
  revision: ShelfExportRevision,
  previous: Receipt | null,
  folderFor: Map<string, string | null>,
): Promise<Receipt> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const key = importKey(exportId, revision.id, attempt);
    const target = previous
      ? { artifactId: previous.artifactId, baseRevisionId: previous.revisionId }
      : { folderId: item.folderId ? (folderFor.get(item.folderId) ?? null) : null };
    try {
      return revision.storageKind === "single"
        ? await saveSingle(actor, blobs, key, item, revision, target)
        : await saveBundle(actor, blobs, key, item, revision, target);
    } catch (error) {
      if (error instanceof Problem && error.status === 410 && attempt < ATTEMPTS - 1) continue;
      throw error;
    }
  }
  throw new ImportRefusal("Загрузка версии всё время истекает.");
}

type Target = { artifactId: string; baseRevisionId: string } | { folderId: string | null };

const singleInput = (key: string, item: ShelfExportItem, revision: ShelfExportRevision, target: Target) => {
  const provenance = (revision.manifest as { provenance?: { kind?: string; sourceUrl?: string | null } } | null)?.provenance;
  return beginUploadSchema.parse({
    key,
    title: item.title,
    filename: revision.filename,
    mime: revision.mime,
    size: revision.size,
    sha256: revision.sha256,
    ...target,
    ...(revision.mime === "text/html" && provenance?.kind === "url" && provenance.sourceUrl
      ? { sourceUrl: provenance.sourceUrl }
      : {}),
  });
};

const bundleInput = (key: string, item: ShelfExportItem, revision: ShelfExportRevision, target: Target) =>
  normalizeBundleRequest({ key, title: item.title, manifest: revision.manifest, ...target });

const refusedFields = (error: z.ZodError) =>
  `эта установка не принимает версию (${[...new Set(error.issues.map((issue) => issue.path.join(".") || "запрос"))].join(", ")})`;

/** Why this installation would refuse the version's save request, or null. */
function acceptedHere(item: ShelfExportItem, revision: ShelfExportRevision) {
  const probe = "00000000-0000-4000-8000-000000000000";
  const target = revision.number === 1 ? { folderId: null } : { artifactId: probe, baseRevisionId: probe };
  try {
    if (revision.storageKind === "single") singleInput(probe, item, revision, target);
    else bundleInput(probe, item, revision, target);
    return null;
  } catch (error) {
    if (error instanceof z.ZodError) return `версия ${revision.number}: ${refusedFields(error)}`;
    throw error;
  }
}

async function saveSingle(actor: Actor, blobs: string, key: string, item: ShelfExportItem, revision: ShelfExportRevision, target: Target) {
  const input = singleInput(key, item, revision, target);
  const begun = await transaction((c) => beginUploadInTransaction(c, actor, input));
  if (begun.receipt) return begun.receipt as Receipt;
  const bytes = await readFile(join(blobs, revision.sha256));
  const staged = await stageUploadBytes(actor, begun.uploadId, bytes);
  await transaction((c) => uploadBytesInTransaction(c, actor, begun.uploadId, bytes, staged));
  const prepared = await prepareUploadFinalize(actor, begun.uploadId);
  return transaction(async (c) => {
    const receipt = (await finalizeUploadInTransaction(c, actor, begun.uploadId, prepared)) as Receipt;
    await restoreVersion(c, receipt, revision);
    return receipt;
  });
}

async function saveBundle(actor: Actor, blobs: string, key: string, item: ShelfExportItem, revision: ShelfExportRevision, target: Target) {
  const input = bundleInput(key, item, revision, target);
  const begun = await transaction((c) => beginBundleUploadInTransaction(c, actor, input));
  if (begun.receipt) return begun.receipt as Receipt;
  for (const [index, file] of begun.manifest.files.entries()) {
    const path = join(blobs, file.sha256);
    if (isVideoMime(file.mime)) {
      const stream = createReadStream(path);
      let staged: string | null;
      try {
        staged = await stageBundleMedia(actor, begun.uploadId, index, stream, () => stream.destroy());
      } finally {
        stream.destroy();
      }
      await transaction((c) => uploadBundleFileInTransaction(c, actor, begun.uploadId, index, null, staged));
    } else {
      const bytes = await readFile(path);
      const staged = await stageBundleFile(actor, begun.uploadId, index, bytes);
      await transaction((c) => uploadBundleFileInTransaction(c, actor, begun.uploadId, index, bytes, staged));
    }
  }
  const prepared = await prepareBundleFinalize(actor, begun.uploadId);
  return transaction(async (c) => {
    const receipt = (await finalizeBundleUploadInTransaction(c, actor, begun.uploadId, prepared)) as Receipt;
    await restoreVersion(c, receipt, revision);
    return receipt;
  });
}

/**
 * In the transaction that saved the version: its original date, and for a
 * single HTML page the provenance it was saved with (the server writes a new
 * one with the time of this save).
 */
async function restoreVersion(c: PoolClient, receipt: Receipt, revision: ShelfExportRevision) {
  if (receipt.number !== revision.number)
    throw new ImportRefusal(`Версия ${revision.number} сохранилась под номером ${receipt.number}: у работы уже есть другие версии.`);
  await c.query("UPDATE revisions SET created_at=$2 WHERE id=$1", [receipt.revisionId, revision.createdAt]);
  if (revision.storageKind !== "single" || !revision.manifest) return;
  const {
    rows: [saved],
  } = await c.query("SELECT manifest FROM revisions WHERE id=$1", [receipt.revisionId]);
  if (!saved?.manifest) return;
  const source = canonicalizeManifest(revision.manifest);
  const manifest = canonicalizeManifest({ ...saved.manifest, provenance: source.provenance });
  if (JSON.stringify(manifest.files) !== JSON.stringify(source.files)) return;
  const manifestSha256 = sha256(JSON.stringify(manifest));
  await c.query("UPDATE revisions SET manifest=$2,manifest_sha256=$3 WHERE id=$1", [
    receipt.revisionId,
    manifest,
    manifestSha256,
  ]);
  await c.query(
    `UPDATE uploads SET receipt=jsonb_set(receipt,'{manifestSha256}',to_jsonb($2::text))
      WHERE tenant_id=(SELECT tenant_id FROM revisions WHERE id=$1) AND receipt->>'revisionId'=$1::text`,
    [receipt.revisionId, manifestSha256],
  );
}

/** After the last version: title, folder, accepted version, the person responsible, dates and the trash. */
/** The numbers of the work's versions that moderation here holds isolated. */
async function blockedVersions(actor: Actor, artifactId: string) {
  const { rows } = await db.query(
    `SELECT DISTINCT r.number FROM moderation_blocks block JOIN revisions r ON r.id=block.revision_id
      WHERE block.tenant_id=$1 AND block.artifact_id=$2 AND block.isolated AND block.released_at IS NULL
      ORDER BY r.number`,
    [actor.tenant, artifactId],
  );
  return rows.map((row) => row.number as number);
}

/** The work was finished by a run of this export (the journal marks it). */
async function finished(actor: Actor, exportId: string, artifactId: string) {
  const { rowCount } = await db.query(
    "SELECT 1 FROM audit_outbox WHERE tenant_id=$1 AND target_id=$2 AND action='artifact.imported' AND payload->>'exportId'=$3",
    [actor.tenant, artifactId, exportId],
  );
  return !!rowCount;
}

async function finishWork(
  actor: Actor,
  exportId: string,
  item: ShelfExportItem,
  last: Receipt,
  folderFor: Map<string, string | null>,
) {
  // Every version kept its number (restoreVersion checks it): the accepted one by its number.
  const source = item.revisions.find((revision) => revision.id === item.acceptedRevisionId);
  const {
    rows: [target],
  } = source
    ? await db.query("SELECT id FROM revisions WHERE artifact_id=$1 AND tenant_id=$2 AND number=$3", [
        last.artifactId,
        actor.tenant,
        source.number,
      ])
    : { rows: [] };
  const accepted: string | null = target?.id ?? null;
  await transaction(async (c) => {
    await lockShelf(c, actor, "curator");
    const {
      rows: [work],
    } = await c.query(
      "SELECT accepted_revision_id FROM artifacts WHERE id=$1 AND tenant_id=$2 AND purged_at IS NULL FOR UPDATE",
      [last.artifactId, actor.tenant],
    );
    if (!work) throw new ImportRefusal("Работа удалена на этой установке во время переноса.");
    // Runs once per work (the marker below): the work was created by this
    // import a moment ago, so it has no links, grants or uploads to close the
    // way artifact-trash.ts does when a person moves a work to the trash.
    await c.query(
      `UPDATE artifacts
          SET title=$3,folder_id=$4,accepted_revision_id=$5,owner_account_id=$6,updated_at=$7,
              lifecycle_version=lifecycle_version+CASE WHEN (trashed_at IS NULL)<>($8::timestamptz IS NULL) THEN 1 ELSE 0 END,
              trashed_at=$8
        WHERE id=$1 AND tenant_id=$2`,
      [
        last.artifactId,
        actor.tenant,
        item.title,
        item.folderId ? (folderFor.get(item.folderId) ?? null) : null,
        accepted,
        item.ownerIsSelf ? actor.id : null,
        item.updatedAt,
        item.trashedAt,
      ],
    );
    // Marks the work finished: a rerun leaves it as the owner has it by then.
    await audit(c, actor, "artifact.imported", last.artifactId, {
      artifactId: last.artifactId,
      exportId,
      sourceId: item.id,
    });
    // The acceptance with its original time, so the shelf snapshot sees it then.
    if (accepted)
      await c.query(
        `INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id,actor_type,payload,created_at)
         SELECT $1,$2,'revision.accepted',$3,'human',$4,$5
          WHERE NOT EXISTS (SELECT 1 FROM audit_outbox WHERE tenant_id=$1 AND target_id=$3
                              AND action='revision.accepted' AND payload->>'revisionId'=$6)`,
        [
          actor.tenant,
          actor.id,
          last.artifactId,
          { artifactId: last.artifactId, revisionId: accepted },
          item.acceptedAt ?? item.updatedAt,
          accepted,
        ],
      );
  });
}
