import { randomUUID, createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import {
  beginUploadSchema,
  MAX_BYTES,
  type HtmlProfile,
  type Revision,
  type Share,
  type Artifact,
} from "../../packages/contracts/index.ts";
import {
  beginBundleUploadSchema,
  canonicalizeManifest,
  type BundleExport,
  type BundleManifest,
} from "../../packages/contracts/bundle.ts";
import { afterCommit, db, transaction } from "./db.ts";
import { config } from "./config.ts";
import { putImmutable, readBlob, sha256 } from "./storage.ts";
import { Problem, missing } from "./errors.ts";
import {
  inspectHtmlBounded,
  looksLikeHtml,
  scanTextBounded,
  type HtmlInspection,
} from "./html.ts";
import { SignalCollector, scanScript } from "./phishing-signals.ts";
import {
  fraudScore,
  mergeResults,
  type FilterResult,
} from "./content-filter/scanner.ts";
import { CATEGORY_LABEL, decideContent } from "./content-filter/policy.ts";
import {
  blockRevisionInTransaction,
  blockedHash,
  queueReview,
} from "./content-moderation.ts";
import {
  createSingleHtmlRevisionManifest,
  isStaticSingleFileBundle,
} from "./revision-manifest.ts";
import {
  SERVED_BUILDER_VERSIONS_SQL,
  SERVED_RUNTIME_PROFILES_SQL,
  derivativePreferenceSql,
  derivativeVersionSql,
} from "./bundle-runtime-contract.ts";
import { assertActiveOwner, lockActiveOwnerTenant } from "./owner-state.ts";
import { trackWorkSaved, viaFor } from "./analytics.ts";
export type Actor = { id: string; tenant: string; connectionId?: string };
export const audit = (
  c: PoolClient,
  actor: Actor,
  action: string,
  target: string,
) =>
  c.query(
    "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id,actor_type,connection_id) VALUES($1,$2,$3,$4,$5,$6)",
    [
      actor.tenant,
      actor.id,
      action,
      target,
      actor.connectionId ? "agent" : "human",
      actor.connectionId ?? null,
    ],
  );
/** Analytics: a work was saved (a new one or a version); `first` for the shelf. */
async function trackSaved(
  c: PoolClient,
  actor: Actor,
  revisionId: string,
  number: number,
) {
  const {
    rows: [earlier],
  } = await c.query(
    "SELECT EXISTS(SELECT 1 FROM revisions WHERE tenant_id=$1 AND id<>$2) AS found",
    [actor.tenant, revisionId],
  );
  trackWorkSaved(
    c,
    actor.id,
    viaFor(actor),
    !earlier.found,
    number === 1 ? "new" : "revision",
  );
}
export const tokenFor = (id: string) =>
  createHmac("sha256", config.LINK_KEY)
    .update(`share:${id}`)
    .digest("base64url");
export const revisionDTO = (r: any): Revision => ({
  manifest: r.manifest ?? null,
  manifestSha256: r.manifest_sha256 ?? null,
  id: r.id,
  number: r.number,
  filename: r.filename,
  mime: r.mime,
  size: r.size,
  sha256: r.sha256,
  storageKind: r.storage_kind ?? "single",
  totalSize: Number(r.total_size ?? r.size),
  htmlProfile: r.html_profile ?? null,
  inlineBuild:
    config.HTML_LIVE_ENABLED && r.inline_build
      ? {
          state: r.inline_build.state,
          runtimeProfile: r.inline_build.runtimeProfile ?? null,
          reason: r.inline_build.reason ?? null,
          path: r.inline_build.path ?? null,
        }
      : null,
  createdAt: new Date(r.created_at).toISOString(),
});
export function shareDTO(s: any, latest: string): Share | null {
  if (!s) return null;
  const status = s.revoked
    ? "revoked"
    : new Date(s.expires_at).getTime() <= Date.now()
      ? "expired"
      : s.revision_id === latest
        ? "active"
        : "behind";
  return {
    id: s.id,
    revisionId: s.revision_id,
    number: s.number,
    status,
    moderation: s.moderation ?? "none",
    ...(s.moderation === "blocked"
      ? { appeal: config.OPERATOR_CONTACT ?? config.OPERATOR_EMAIL ?? null }
      : {}),
    expiresAt: new Date(s.expires_at).toISOString(),
    url: ["active", "behind"].includes(status)
      ? `${config.APP_ORIGIN}/s#${tokenFor(s.id)}`
      : null,
  };
}
export async function getArtifact(actor: Actor, id: string): Promise<Artifact> {
  const [artifact] = await getArtifacts(actor, [id]);
  if (!artifact) throw missing();
  return artifact;
}
/** Owner detail for several artifacts in three queries; missing ids are skipped, order is kept. */
export async function getArtifacts(
  actor: Actor,
  ids: string[],
): Promise<Artifact[]> {
  await assertActiveOwner(db, actor);
  if (!ids.length) return [];
  const { rows: artifacts } = await db.query(
    "SELECT * FROM artifacts WHERE id=ANY($1::uuid[]) AND tenant_id=$2",
    [ids, actor.tenant],
  );
  if (!artifacts.length) return [];
  const { rows: revisions } = await db.query(
    `SELECT r.*,
       (SELECT jsonb_build_object(
          'state',d.state,'runtimeProfile',CASE WHEN d.state='ready' THEN d.runtime_profile ELSE NULL END,
          'reason',d.reason,'path',d.error_path
        ) FROM revision_derivatives d
        WHERE d.revision_id=r.id AND d.source_manifest_sha256=r.manifest_sha256
          AND ${derivativeVersionSql("d")}
        ORDER BY ${derivativePreferenceSql("d")} LIMIT 1) AS inline_build
     FROM revisions r WHERE r.id=ANY($1::uuid[])`,
    [artifacts.map((a) => a.latest_revision_id)],
  );
  const { rows: shares } = await db.query(
    `SELECT DISTINCT ON (s.artifact_id) s.*,r.number
       FROM shares s JOIN revisions r ON r.id=s.revision_id
      WHERE s.artifact_id=ANY($1::uuid[])
      ORDER BY s.artifact_id,s.created_at DESC,s.id DESC`,
    [artifacts.map((a) => a.id)],
  );
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const revisionById = new Map(revisions.map((r) => [r.id, r]));
  const shareByArtifact = new Map(shares.map((s) => [s.artifact_id, s]));
  return ids.flatMap((id) => {
    const a = byId.get(id);
    if (!a) return [];
    const r = revisionById.get(a.latest_revision_id);
    return [
      {
        id: a.id,
        title: a.title,
        folderId: a.folder_id,
        updatedAt: a.updated_at.toISOString(),
        trashedAt: a.trashed_at ? a.trashed_at.toISOString() : null,
        lifecycleVersion: Number(a.lifecycle_version),
        revision: revisionDTO(r),
        share: shareDTO(shareByArtifact.get(a.id), r.id),
      },
    ];
  });
}
export async function beginUpload(actor: Actor, body: unknown) {
  const input = beginUploadSchema.parse(body);
  return transaction((c) => beginUploadInTransaction(c, actor, input));
}
export async function beginUploadInTransaction(
  c: PoolClient,
  actor: Actor,
  input: ReturnType<typeof beginUploadSchema.parse>,
) {
  const tenant = await lockActiveOwnerTenant(c, actor);
  const {
    rows: [old],
  } = await c.query(
    "SELECT * FROM uploads WHERE tenant_id=$1 AND idempotency_key=$2",
    [actor.tenant, input.key],
  );
  if (old) {
    if (old.kind !== "single")
      throw new Problem(
        409,
        "conflict",
        "Этот ключ уже относится к пакетной загрузке.",
      );
    if (
      JSON.stringify(beginUploadSchema.parse(old.request)) !==
      JSON.stringify(input)
    )
      throw new Problem(
        409,
        "conflict",
        "Этот повтор относится к другому файлу. Начните новую загрузку.",
      );
    if (
      old.aborted ||
      (!old.receipt && new Date(old.expires_at).getTime() <= Date.now())
    )
      throw new Problem(
        410,
        "expired",
        "Время загрузки истекло. Выберите файл снова.",
      );
    if (!old.receipt)
      await validateUploadTarget(
        c,
        actor,
        beginUploadSchema.parse(old.request),
      );
    return { uploadId: old.id, receipt: old.receipt };
  }
  if (
    input.folderId &&
    !(
      await c.query("SELECT 1 FROM folders WHERE id=$1 AND tenant_id=$2", [
        input.folderId,
        actor.tenant,
      ])
    ).rowCount
  )
    throw missing();
  if (input.artifactId) {
    const {
      rows: [a],
    } = await c.query(
      "SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL",
      [input.artifactId, actor.tenant],
    );
    if (!a) throw missing();
    if (a.latest_revision_id !== input.baseRevisionId)
      throw new Problem(
        409,
        "conflict",
        "Работа уже изменилась. Откройте текущую версию.",
      );
  }
  const {
    rows: [pending],
  } = await c.query(
    "SELECT COALESCE(sum((request->>'size')::bigint),0) AS size,count(*) AS count FROM uploads WHERE tenant_id=$1 AND receipt IS NULL AND NOT aborted AND expires_at>now()",
    [actor.tenant],
  );
  if (
    +tenant.used_bytes + +pending.size + input.size > +tenant.quota_bytes ||
    +pending.count >= 8
  )
    throw new Problem(
      413,
      "quota",
      "Достигнут лимит хранения или одновременных загрузок.",
    );
  const id = randomUUID();
  await c.query(
    "INSERT INTO uploads(id,tenant_id,account_id,idempotency_key,request,kind) VALUES($1,$2,$3,$4,$5,'single')",
    [id, actor.tenant, actor.id, input.key, input],
  );
  return { uploadId: id, receipt: null };
}
async function validateBytes(
  bytes: Buffer,
  input: ReturnType<typeof beginUploadSchema.parse>,
): Promise<HtmlInspection | null> {
  if (bytes.length !== input.size || sha256(bytes) !== input.sha256)
    throw new Problem(
      422,
      "invalid",
      "Файл передан не полностью или изменился. Загрузите его заново.",
    );
  const valid =
    input.mime === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      : input.mime === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : input.mime === "image/webp"
          ? bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          : true;
  if (!valid)
    throw new Problem(
      422,
      "invalid",
      "Содержимое файла не соответствует выбранному формату.",
    );
  if (input.mime === "text/plain" || input.mime === "text/html") {
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (bytes.includes(0)) throw new Error();
    } catch {
      throw new Problem(
        422,
        "invalid",
        input.mime === "text/html"
          ? "Для HTML-страницы поддерживается кодировка UTF-8."
          : "Для текста поддерживается кодировка UTF-8.",
      );
    }
    if (input.mime === "text/html") {
      if (!looksLikeHtml(source))
        throw new Problem(
          422,
          "invalid",
          "Это не похоже на HTML-страницу. Сохраните её как текст или выберите файл .html.",
        );
      return inspectHtmlBounded(source);
    }
  }
  return null;
}
// Links are never issued for a page that cannot be shown without a runtime.
export async function assertLinkable(c: PoolClient, revisionId: string) {
  const {
    rows: [r],
  } = await c.query(
    `SELECT r.html_profile,r.storage_kind,r.mime,r.manifest,
       (SELECT d.id FROM revision_derivatives d
        WHERE d.revision_id=r.id AND d.source_manifest_sha256=r.manifest_sha256
          AND d.builder_version IN ${SERVED_BUILDER_VERSIONS_SQL}
          AND d.runtime_profile IN ${SERVED_RUNTIME_PROFILES_SQL} AND d.state='ready'
        ORDER BY ${derivativePreferenceSql("d")} LIMIT 1) AS derivative_id
     FROM revisions r
     WHERE r.id=$1`,
    [revisionId],
  );
  if (!r) throw missing();
  if (r.storage_kind === "bundle") {
    if (config.HTML_LIVE_ENABLED && r.derivative_id)
      return r.derivative_id as string;
    // A lone static page is linked like a single upload: static sandbox only.
    if (isStaticSingleFileBundle(r)) return null;
    const single = r.manifest?.files?.length === 1;
    throw new Problem(
      422,
      "unsupported",
      single
        ? config.HTML_LIVE_ENABLED
          ? "Статичный просмотр не покажет эту страницу: ей нужны скрипты, формы или внешние ресурсы. Подготовьте интерактивную версию (polka_prepare_preview) и повторите, либо сохраните страницу без скриптов и внешних ссылок."
          : "Статичный просмотр не покажет эту страницу: ей нужны скрипты, формы или внешние ресурсы, а интерактивный просмотр на этой установке выключен. Ссылку не выпускаем; сохраните страницу одним HTML-файлом без скриптов, форм и внешних ссылок."
        : config.HTML_LIVE_ENABLED
          ? "Пакет из нескольких файлов открывается только в интерактивной версии, а она ещё не подготовлена. Подготовьте её (polka_prepare_preview) и повторите."
          : "Пакет из нескольких файлов открывается только в интерактивной версии, а интерактивный просмотр на этой установке выключен. Ссылку не выпускаем; сохраните страницу одним самодостаточным HTML-файлом (стили и картинки встроены) без скриптов.",
    );
  }
  // A single page with scripts is linked to its built interactive version when
  // one is ready; recipients never run the raw upload.
  if (
    config.HTML_LIVE_ENABLED &&
    r.derivative_id &&
    r.mime === "text/html" &&
    (r.html_profile === "limited" || r.html_profile === "unsupported")
  )
    return r.derivative_id as string;
  if (r.html_profile === "unsupported") {
    throw new Problem(
      422,
      "unsupported",
      config.HTML_LIVE_ENABLED
        ? "Статичный просмотр не покажет эту страницу, а её интерактивная версия ещё не подготовлена или не собралась. Подготовьте интерактивную версию и повторите."
        : "Эта страница собирается скриптами, а интерактивный просмотр в этой сборке ещё не включён. Ссылку на неё не выпускаем.",
    );
  }
  return null;
}
async function lockUpload(c: PoolClient, actor: Actor, id: string) {
  const {
    rows: [u],
  } = await c.query(
    "SELECT * FROM uploads WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
    [id, actor.tenant],
  );
  if (!u) throw missing();
  if (
    u.aborted ||
    (!u.receipt && new Date(u.expires_at).getTime() <= Date.now())
  )
    throw new Problem(
      410,
      "expired",
      "Загрузка отменена или истекла. Выберите файл снова.",
    );
  return u;
}
export async function uploadBytes(actor: Actor, id: string, bytes: Buffer) {
  return transaction((c) => uploadBytesInTransaction(c, actor, id, bytes));
}
export async function uploadBytesInTransaction(
  c: PoolClient,
  actor: Actor,
  id: string,
  bytes: Buffer,
) {
  await lockActiveOwnerTenant(c, actor);
  const u = await lockUpload(c, actor, id);
  if (u.kind !== "single") throw missing();
  const input = beginUploadSchema.parse(u.request);
  await validateBytes(bytes, input);
  if (u.receipt) return { stored: true };
  await validateUploadTarget(c, actor, input);
  const version = await putImmutable(`${actor.tenant}/${id}`, bytes);
  await c.query("UPDATE uploads SET object_version=$2 WHERE id=$1", [
    id,
    version,
  ]);
  return { stored: true };
}
/**
 * The content filter at save time (docs/specs/CONTENT_FILTER.md): a re-upload
 * of blocked bytes, CSAM at its block score, and in strict mode a severe
 * category at its high score block the new revision at once, in this
 * transaction, and disable the author (CSAM, strict). Everything else is
 * decided when a link is made.
 */
async function screenSavedRevision(
  c: PoolClient,
  actor: Actor,
  saved: {
    artifactId: string;
    revisionId: string;
    sha256: string;
    filter: FilterResult;
    /** A bundle's files: each one is checked against the stop list too. */
    fileHashes?: string[];
  },
) {
  if (config.CONTENT_FILTER_MODE === "off") return;
  let known = await blockedHash(c, saved.sha256);
  for (const hash of saved.fileHashes ?? []) {
    if (known) break;
    known = await blockedHash(c, hash);
  }
  // The SHA-256 stop list: blocked bytes are not saved again by anyone. For
  // CSAM the save goes through and is blocked at once (the author is
  // disabled, the attempt is evidence); anything else is refused.
  if (known && known !== "csam")
    throw new Problem(
      403,
      "forbidden",
      "Этот файл заблокирован модератором Полки и не может быть сохранён.",
    );
  const decision = known
    ? null
    : decideContent({
        filter: saved.filter,
        standing: { trusted: true, operatorCreated: false },
        mode: config.CONTENT_FILTER_MODE,
        autoblock: config.CONTENT_FILTER_AUTOBLOCK,
        fraud: false,
      });
  // The models read it after this save commits; the save never waits.
  afterCommit(c, () => queueReview(saved.revisionId));
  const category = known ?? (decision?.action === "block" ? decision.category : null);
  if (!category) return;
  const freeze = known
    ? known === "csam" || config.CONTENT_FILTER_MODE === "strict"
    : !!decision?.freeze;
  const outcome = await blockRevisionInTransaction(c, {
    tenantId: actor.tenant,
    accountId: actor.id,
    artifactId: saved.artifactId,
    revisionId: saved.revisionId,
    category,
    actor: "filter",
    reason: known
      ? "повторная загрузка заблокированного содержимого (тот же sha256)"
      : `фильтр содержимого при сохранении: ${CATEGORY_LABEL[category]}`,
    freeze,
    details: decision
      ? {
          findings: decision.findings.map((finding) =>
            finding.category === "csam"
              ? { category: "csam", score: finding.score }
              : finding,
          ),
        }
      : { knownHash: true },
  });
  if (outcome.created) {
    afterCommit(c, async () => {
      const { dispatchModerationNotices } = await import("./moderation-mail.ts");
      await dispatchModerationNotices([
        {
          kind: "blocked",
          shareId: outcome.shareIds[0] ?? null,
          revisionId: saved.revisionId,
          category,
          frozen: outcome.frozen,
          by: "filter",
          ...(decision ? { content: decision } : {}),
        },
      ]);
    });
  }
}

export async function finalizeUpload(actor: Actor, id: string) {
  return transaction((c) => finalizeUploadInTransaction(c, actor, id));
}
export async function finalizeUploadInTransaction(
  c: PoolClient,
  actor: Actor,
  id: string,
) {
  // All quota changes take the same tenant lock before upload/artifact locks.
  const tenant = await lockActiveOwnerTenant(c, actor);
  const u = await lockUpload(c, actor, id);
  if (u.kind !== "single") throw missing();
  if (u.receipt) return u.receipt;
  if (!u.object_version)
    throw new Problem(409, "conflict", "Сначала дождитесь передачи файла.");
  const input = beginUploadSchema.parse(u.request);
  await validateUploadTarget(c, actor, input);
  const bytes = await readBlob(`${actor.tenant}/${id}`, u.object_version);
  const inspection = await validateBytes(bytes, input);
  const htmlProfile = inspection?.profile ?? null;
  // The content filter: a page's findings come with its inspection; a text
  // file is read the same way; an image has no text (the model sees it when
  // a link is made).
  const contentFilter: FilterResult =
    inspection?.filter ??
    (input.mime === "text/plain"
      ? await scanTextBounded(bytes.toString("utf8"))
      : { v: 1, hits: {} });
  let revisionManifest: ReturnType<
    typeof createSingleHtmlRevisionManifest
  > | null = null;
  if (input.mime === "text/html") {
    if (!htmlProfile) throw new Error("HTML profile invariant failed");
    revisionManifest = createSingleHtmlRevisionManifest(
      bytes,
      htmlProfile,
      new Date(),
      input.sourceUrl ?? null,
    );
  }
  if (+tenant.used_bytes + input.size > +tenant.quota_bytes)
    throw new Problem(413, "quota", "Недостаточно места для этой версии.");
  if (
    !(
      await c.query(
        "SELECT 1 FROM accounts WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL",
        [actor.id],
      )
    ).rowCount
  )
    throw new Problem(403, "forbidden", "Доступ к аккаунту закрыт.");
  let artifactId = input.artifactId,
    number = 1;
  if (artifactId) {
    const {
      rows: [a],
    } = await c.query(
      "SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL FOR UPDATE",
      [artifactId, actor.tenant],
    );
    if (!a) throw missing();
    if (a.latest_revision_id !== input.baseRevisionId)
      throw new Problem(
        409,
        "conflict",
        "Появилась другая версия. Сохранённый файл не заменил её; откройте работу заново.",
      );
    const {
      rows: [last],
    } = await c.query("SELECT number FROM revisions WHERE id=$1", [
      a.latest_revision_id,
    ]);
    number = last.number + 1;
  } else {
    artifactId = randomUUID();
    await c.query(
      "INSERT INTO artifacts(id,tenant_id,created_by,folder_id,title) VALUES($1,$2,$3,$4,$5)",
      [artifactId, actor.tenant, actor.id, input.folderId ?? null, input.title],
    );
  }
  const revisionId = randomUUID();
  await c.query(
    "INSERT INTO revisions(id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,object_key,object_version,html_profile,manifest,manifest_sha256,storage_kind,total_size,phishing_signals,content_filter) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'single',$15,$16,$17)",
    [
      revisionId,
      actor.tenant,
      artifactId,
      number,
      actor.id,
      input.filename,
      input.mime,
      input.size,
      input.sha256,
      `${actor.tenant}/${id}`,
      u.object_version,
      htmlProfile,
      revisionManifest?.manifest ?? null,
      revisionManifest?.manifestSha256 ?? null,
      input.size,
      inspection?.signals ?? [],
      contentFilter,
    ],
  );
  await screenSavedRevision(c, actor, {
    artifactId,
    revisionId,
    sha256: input.sha256,
    filter: contentFilter,
  });
  await c.query(
    "UPDATE artifacts SET latest_revision_id=$2,updated_at=clock_timestamp() WHERE id=$1",
    [artifactId, revisionId],
  );
  await c.query("UPDATE tenants SET used_bytes=used_bytes+$2 WHERE id=$1", [
    actor.tenant,
    input.size,
  ]);
  const receipt = {
    uploadId: id,
    artifactId,
    revisionId,
    number,
    sha256: input.sha256,
    htmlProfile,
    ...(revisionManifest
      ? { manifestSha256: revisionManifest.manifestSha256 }
      : {}),
  };
  await c.query("UPDATE uploads SET receipt=$2 WHERE id=$1", [id, receipt]);
  await audit(c, actor, "revision.saved", revisionId);
  await trackSaved(c, actor, revisionId, number);
  return receipt;
}

type NormalizedBundleRequest = {
  key: string;
  title: string;
  manifest: BundleManifest;
  artifactId?: string;
  baseRevisionId?: string;
  folderId?: string | null;
  size: number;
};

export function normalizeBundleRequest(
  body: unknown,
  stored = false,
): NormalizedBundleRequest {
  const source =
    body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const parsedBody = stored
    ? Object.fromEntries(
        Object.entries(source).filter(([key]) => key !== "size"),
      )
    : body;
  const input = beginBundleUploadSchema.parse(parsedBody);
  const manifest = canonicalizeManifest(input.manifest);
  const normalized = {
    key: input.key,
    title: input.title,
    manifest,
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.baseRevisionId ? { baseRevisionId: input.baseRevisionId } : {}),
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    size: manifest.files.reduce((total, file) => total + file.size, 0),
  };
  if (stored && source.size !== normalized.size)
    throw new Error("Stored bundle size mismatch");
  return normalized;
}

async function validateUploadTarget(
  c: PoolClient,
  actor: Actor,
  input: {
    folderId?: string | null;
    artifactId?: string;
    baseRevisionId?: string;
  },
) {
  if (
    input.folderId &&
    !(
      await c.query("SELECT 1 FROM folders WHERE id=$1 AND tenant_id=$2", [
        input.folderId,
        actor.tenant,
      ])
    ).rowCount
  )
    throw missing();
  if (input.artifactId) {
    const {
      rows: [artifact],
    } = await c.query(
      "SELECT latest_revision_id FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL",
      [input.artifactId, actor.tenant],
    );
    if (!artifact) throw missing();
    if (artifact.latest_revision_id !== input.baseRevisionId)
      throw new Problem(
        409,
        "conflict",
        "Работа уже изменилась. Откройте текущую версию.",
      );
  }
}

export async function beginBundleUpload(actor: Actor, body: unknown) {
  const input = normalizeBundleRequest(body);
  return transaction((c) => beginBundleUploadInTransaction(c, actor, input));
}
export async function beginBundleUploadInTransaction(
  c: PoolClient,
  actor: Actor,
  input: NormalizedBundleRequest,
) {
  const tenant = await lockActiveOwnerTenant(c, actor);
  const {
    rows: [old],
  } = await c.query(
    "SELECT * FROM uploads WHERE tenant_id=$1 AND idempotency_key=$2",
    [actor.tenant, input.key],
  );
  if (old) {
    if (
      old.kind !== "bundle" ||
      JSON.stringify(normalizeBundleRequest(old.request, true)) !==
        JSON.stringify(input)
    )
      throw new Problem(
        409,
        "conflict",
        "Этот ключ уже относится к другой загрузке.",
      );
    if (
      old.aborted ||
      (!old.receipt && new Date(old.expires_at).getTime() <= Date.now())
    )
      throw new Problem(
        410,
        "expired",
        "Время загрузки истекло. Начните пакетную загрузку снова.",
      );
    if (!old.receipt)
      await validateUploadTarget(
        c,
        actor,
        normalizeBundleRequest(old.request, true),
      );
    return {
      uploadId: old.id,
      receipt: old.receipt,
      manifest: input.manifest,
    };
  }
  await validateUploadTarget(c, actor, input);
  const {
    rows: [pending],
  } = await c.query(
    "SELECT COALESCE(sum((request->>'size')::bigint),0) AS size,count(*) AS count FROM uploads WHERE tenant_id=$1 AND receipt IS NULL AND NOT aborted AND expires_at>now()",
    [actor.tenant],
  );
  if (
    +tenant.used_bytes + +pending.size + input.size > +tenant.quota_bytes ||
    +pending.count >= 8
  )
    throw new Problem(
      413,
      "quota",
      "Достигнут лимит хранения или одновременных загрузок.",
    );
  const uploadId = randomUUID();
  await c.query(
    "INSERT INTO uploads(id,tenant_id,account_id,idempotency_key,request,kind) VALUES($1,$2,$3,$4,$5,'bundle')",
    [uploadId, actor.tenant, actor.id, input.key, input],
  );
  return { uploadId, receipt: null, manifest: input.manifest };
}

const bundleFileKey = (
  tenant: string,
  uploadId: string,
  manifest: BundleManifest,
  index: number,
) =>
  manifest.files[index].path === manifest.entrypoint
    ? `${tenant}/${uploadId}`
    : `${tenant}/${uploadId}/files/${index}`;

export function validateBundleFileBytes(
  file: BundleManifest["files"][number],
  bytes: Buffer,
) {
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
    throw new Problem(
      422,
      "invalid",
      "Файл пакета передан не полностью или изменился.",
    );
  const binaryValid =
    file.mime === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      : file.mime === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : file.mime === "image/webp"
          ? bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          : file.mime === "font/woff2"
            ? bytes.toString("ascii", 0, 4) === "wOF2"
            : true;
  if (!binaryValid)
    throw new Problem(
      422,
      "invalid",
      "Содержимое файла пакета не соответствует заявленному формату.",
    );
  if (
    file.mime.startsWith("text/") ||
    file.mime === "application/json" ||
    file.mime === "image/svg+xml"
  ) {
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (bytes.includes(0)) throw new Error();
    } catch {
      throw new Problem(
        422,
        "invalid",
        "Текстовый файл пакета должен быть в UTF-8.",
      );
    }
    if (file.mime === "text/html" && !looksLikeHtml(source))
      throw new Problem(422, "invalid", "HTML-файл пакета не похож на HTML.");
    if (file.mime === "image/svg+xml" && !/<svg\b/i.test(source))
      throw new Problem(422, "invalid", "SVG-файл пакета не похож на SVG.");
    if (file.mime === "application/json")
      try {
        JSON.parse(source);
      } catch {
        throw new Problem(422, "invalid", "JSON-файл пакета некорректен.");
      }
  }
}

export async function uploadBundleFile(
  actor: Actor,
  id: string,
  index: number,
  bytes: Buffer,
) {
  return transaction((c) =>
    uploadBundleFileInTransaction(c, actor, id, index, bytes),
  );
}
export async function uploadBundleFileInTransaction(
  c: PoolClient,
  actor: Actor,
  id: string,
  index: number,
  bytes: Buffer,
) {
  await lockActiveOwnerTenant(c, actor);
  const upload = await lockUpload(c, actor, id);
  if (upload.kind !== "bundle") throw missing();
  const input = normalizeBundleRequest(upload.request, true);
  const expected = input.manifest.files[index];
  if (!expected) throw missing();
  validateBundleFileBytes(expected, bytes);
  if (upload.receipt) return { stored: true, index };
  await validateUploadTarget(c, actor, input);
  const existing = (
    await c.query(
      "SELECT object_version FROM upload_files WHERE upload_id=$1 AND file_index=$2",
      [id, index],
    )
  ).rows[0];
  if (existing) return { stored: true, index };
  const objectKey = bundleFileKey(actor.tenant, id, input.manifest, index);
  const objectVersion = await putImmutable(objectKey, bytes);
  await c.query(
    "INSERT INTO upload_files(upload_id,file_index,object_key,object_version) VALUES($1,$2,$3,$4)",
    [id, index, objectKey, objectVersion],
  );
  return { stored: true, index };
}

async function lockBundleArtifact(
  c: PoolClient,
  actor: Actor,
  input: NormalizedBundleRequest,
) {
  let artifactId = input.artifactId;
  let number = 1;
  if (artifactId) {
    const {
      rows: [artifact],
    } = await c.query(
      "SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2 AND trashed_at IS NULL FOR UPDATE",
      [artifactId, actor.tenant],
    );
    if (!artifact) throw missing();
    if (artifact.latest_revision_id !== input.baseRevisionId)
      throw new Problem(
        409,
        "conflict",
        "Появилась другая версия. Текущая версия не заменена; откройте её заново.",
      );
    const {
      rows: [last],
    } = await c.query("SELECT number FROM revisions WHERE id=$1", [
      artifact.latest_revision_id,
    ]);
    number = last.number + 1;
  } else {
    artifactId = randomUUID();
    await c.query(
      "INSERT INTO artifacts(id,tenant_id,created_by,folder_id,title) VALUES($1,$2,$3,$4,$5)",
      [artifactId, actor.tenant, actor.id, input.folderId ?? null, input.title],
    );
  }
  return { artifactId, number };
}

export async function finalizeBundleUpload(actor: Actor, id: string) {
  return transaction((c) => finalizeBundleUploadInTransaction(c, actor, id));
}
export async function finalizeBundleUploadInTransaction(
  c: PoolClient,
  actor: Actor,
  id: string,
) {
  const tenant = await lockActiveOwnerTenant(c, actor);
  const upload = await lockUpload(c, actor, id);
  if (upload.kind !== "bundle") throw missing();
  if (upload.receipt) return upload.receipt;
  const input = normalizeBundleRequest(upload.request, true);
  await validateUploadTarget(c, actor, input);
  const staged = (
    await c.query(
      "SELECT * FROM upload_files WHERE upload_id=$1 ORDER BY file_index",
      [id],
    )
  ).rows;
  if (staged.length !== input.manifest.files.length)
    throw new Problem(409, "conflict", "Переданы не все файлы пакета.");
  const verified: Array<{
    file: BundleManifest["files"][number];
    object_key: string;
    object_version: string;
  }> = [];
  let entryBytes: Buffer | null = null;
  // Phishing signals of every page and script of the bundle. Pages go through
  // the same bounded (off-thread, deadline) parse as the profile.
  const signals = new SignalCollector();
  const pageFilters: FilterResult[] = [];
  const inspectPage = async (bytes: Buffer) => {
    const inspection = await inspectHtmlBounded(bytes.toString("utf8"));
    for (const signal of inspection.signals) signals.add(signal);
    pageFilters.push(inspection.filter);
    return inspection.profile;
  };
  for (const [index, file] of input.manifest.files.entries()) {
    const stored = staged.find((row) => row.file_index === index);
    if (
      !stored ||
      stored.object_key !==
        bundleFileKey(actor.tenant, id, input.manifest, index)
    )
      throw new Error("Bundle staging invariant failed");
    const bytes = await readBlob(stored.object_key, stored.object_version);
    validateBundleFileBytes(file, bytes);
    if (file.path === input.manifest.entrypoint) entryBytes = bytes;
    // Phishing signals of every page and script (a lone entrypoint is read
    // below, in the same walk as its profile).
    else if (file.mime === "text/html") await inspectPage(bytes);
    else if (file.mime === "text/javascript")
      scanScript(bytes.toString("utf8"), signals);
    verified.push({ file, ...stored });
  }
  const entryIndex = input.manifest.files.findIndex(
    (file) => file.path === input.manifest.entrypoint,
  );
  const entry = verified[entryIndex];
  // A lone HTML entrypoint is classified exactly like a single upload; every
  // multi-file bundle stays runtime-only until a derivative is prepared.
  const htmlProfile: HtmlProfile =
    input.manifest.files.length === 1 && entryBytes
      ? await inspectPage(entryBytes)
      : "unsupported";
  if (input.manifest.files.length !== 1 && entryBytes)
    await inspectPage(entryBytes);
  if (+tenant.used_bytes + input.size > +tenant.quota_bytes)
    throw new Problem(413, "quota", "Недостаточно места для этого пакета.");
  if (
    !(
      await c.query(
        "SELECT 1 FROM accounts WHERE id=$1 AND NOT disabled AND deletion_requested_at IS NULL",
        [actor.id],
      )
    ).rowCount
  )
    throw new Problem(403, "forbidden", "Доступ к аккаунту закрыт.");
  const { artifactId, number } = await lockBundleArtifact(c, actor, input);
  const revisionId = randomUUID();
  const manifestSha256 = sha256(JSON.stringify(input.manifest));
  // Every page's findings and the scripts' (read by `signals`), with fraud
  // counted once from all the phishing signals together.
  const withoutFraud = (filter: FilterResult): FilterResult => {
    const { fraud: _fraud, ...hits } = filter.hits;
    return { ...filter, hits };
  };
  const contentFilter = mergeResults(
    withoutFraud(signals.content.result()),
    ...pageFilters.map(withoutFraud),
  );
  const fraud = fraudScore(signals.list());
  if (fraud) contentFilter.hits.fraud = fraud;
  await c.query(
    `INSERT INTO revisions(id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,object_key,object_version,html_profile,manifest,manifest_sha256,storage_kind,total_size,phishing_signals,content_filter)
       VALUES($1,$2,$3,$4,$5,$6,'text/html',$7,$8,$9,$10,$14,$11,$12,'bundle',$13,$15,$16)`,
    [
      revisionId,
      actor.tenant,
      artifactId,
      number,
      actor.id,
      input.manifest.entrypoint,
      entry.file.size,
      entry.file.sha256,
      entry.object_key,
      entry.object_version,
      input.manifest,
      manifestSha256,
      input.size,
      htmlProfile,
      signals.list(),
      contentFilter,
    ],
  );
  await screenSavedRevision(c, actor, {
    artifactId,
    revisionId,
    sha256: entry.file.sha256,
    filter: contentFilter,
    fileHashes: input.manifest.files.map((file) => file.sha256),
  });
  for (const [index, stored] of verified.entries())
    await c.query(
      `INSERT INTO revision_files(revision_id,file_index,path,mime,size,sha256,object_key,object_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        revisionId,
        index,
        stored.file.path,
        stored.file.mime,
        stored.file.size,
        stored.file.sha256,
        stored.object_key,
        stored.object_version,
      ],
    );
  await c.query(
    "UPDATE artifacts SET latest_revision_id=$2,updated_at=clock_timestamp() WHERE id=$1",
    [artifactId, revisionId],
  );
  await c.query("UPDATE tenants SET used_bytes=used_bytes+$2 WHERE id=$1", [
    actor.tenant,
    input.size,
  ]);
  const receipt = {
    uploadId: id,
    artifactId,
    revisionId,
    number,
    sha256: entry.file.sha256,
    htmlProfile,
    manifestSha256,
    storageKind: "bundle" as const,
    totalSize: input.size,
  };
  await c.query("UPDATE uploads SET receipt=$2 WHERE id=$1", [id, receipt]);
  await audit(c, actor, "revision.saved", revisionId);
  await trackSaved(c, actor, revisionId, number);
  return receipt;
}

export async function uploadStatus(
  actor: Actor,
  id: string,
  kind: "single" | "bundle",
) {
  await assertActiveOwner(db, actor);
  const {
    rows: [upload],
  } = await db.query(
    "SELECT id,kind,request,receipt,aborted,expires_at FROM uploads WHERE id=$1 AND tenant_id=$2 AND kind=$3",
    [id, actor.tenant, kind],
  );
  if (!upload) throw missing();
  if (kind === "bundle")
    Object.assign(upload, {
      manifest: normalizeBundleRequest(upload.request, true).manifest,
      uploaded: (
        await db.query(
          "SELECT file_index FROM upload_files WHERE upload_id=$1 ORDER BY file_index",
          [id],
        )
      ).rows.map((row) => row.file_index),
    });
  delete upload.kind;
  delete upload.request;
  return upload;
}

export async function abortUpload(
  actor: Actor,
  id: string,
  kind: "single" | "bundle",
) {
  return transaction(async (c) => {
    await lockActiveOwnerTenant(c, actor);
    const result = await c.query(
      "UPDATE uploads SET aborted=true WHERE id=$1 AND tenant_id=$2 AND kind=$3 AND receipt IS NULL",
      [id, actor.tenant, kind],
    );
    if (!result.rowCount) {
      const exists = await c.query(
        "SELECT 1 FROM uploads WHERE id=$1 AND tenant_id=$2 AND kind=$3",
        [id, actor.tenant, kind],
      );
      if (!exists.rowCount) throw missing();
    }
    return { ok: true };
  });
}

export async function readAuthorizedRevisionSource(
  c: Pick<PoolClient, "query">,
  revision: any,
) {
  if (!revision?.manifest || !revision.manifest_sha256) throw missing();
  const manifest = canonicalizeManifest(revision.manifest);
  if (sha256(JSON.stringify(manifest)) !== revision.manifest_sha256)
    throw new Error("Revision manifest checksum mismatch");
  const storedFiles =
    revision.storage_kind === "bundle"
      ? (
          await c.query(
            "SELECT * FROM revision_files WHERE revision_id=$1 ORDER BY file_index",
            [revision.id],
          )
        ).rows
      : [
          {
            file_index: 0,
            path: manifest.entrypoint,
            mime: revision.mime,
            size: revision.size,
            sha256: revision.sha256,
            object_key: revision.object_key,
            object_version: revision.object_version,
          },
        ];
  if (storedFiles.length !== manifest.files.length)
    throw new Error("Revision file count mismatch");
  const files: Array<{
    path: string;
    mime: string;
    size: number;
    sha256: string;
    bytes: Buffer;
  }> = [];
  let totalSize = 0;
  for (const [index, expected] of manifest.files.entries()) {
    const stored = storedFiles[index];
    if (
      !stored ||
      stored.file_index !== index ||
      stored.path !== expected.path ||
      stored.mime !== expected.mime ||
      Number(stored.size) !== expected.size ||
      stored.sha256 !== expected.sha256
    )
      throw new Error("Revision file metadata mismatch");
    const bytes = await readBlob(stored.object_key, stored.object_version);
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256)
      throw new Error("Revision file checksum mismatch");
    totalSize += bytes.length;
    files.push({ ...expected, bytes });
  }
  if (totalSize !== Number(revision.total_size) || totalSize > MAX_BYTES)
    throw new Error("Revision total size mismatch");
  return {
    revision,
    manifest,
    manifestSha256: revision.manifest_sha256 as string,
    files,
  };
}

export async function readRevisionSource(actor: Actor, revisionId: string) {
  await assertActiveOwner(db, actor);
  const {
    rows: [revision],
  } = await db.query("SELECT * FROM revisions WHERE id=$1 AND tenant_id=$2", [
    revisionId,
    actor.tenant,
  ]);
  return readAuthorizedRevisionSource(db, revision);
}

export async function exportRevision(
  actor: Actor,
  revisionId: string,
): Promise<BundleExport> {
  const source = await readRevisionSource(actor, revisionId);
  return {
    manifest: source.manifest,
    manifestSha256: source.manifestSha256,
    files: source.files.map(({ bytes, ...file }) => ({
      ...file,
      encoding: "base64" as const,
      data: bytes.toString("base64"),
    })),
  };
}
