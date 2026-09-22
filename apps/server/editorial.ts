import type { PoolClient } from "pg";
import { z } from "zod";
import {
  editorialPublicationManifestSchema,
  editorialPublicMetadataSchema,
  type EditorialPublicResponse,
} from "../../packages/editorial.ts";
import { canonicalizeManifest } from "../../packages/contracts/bundle.ts";
import { audit, tokenFor, type Actor } from "./artifacts.ts";
import {
  BUNDLE_RUNTIME_PROFILE,
  SERVED_BUILDER_VERSIONS,
  isServedBuilderVersion,
} from "./bundle-runtime-contract.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import { revokeLockedShareInTransaction } from "./shares.ts";
import { sha256 } from "./storage.ts";
import { lockActiveOwnerTenant } from "./owner-state.ts";

const uuid = z.string().uuid();
type Queryable = Pick<PoolClient, "query">;

export const editorialPublishSchema = z
  .object({
    publicationId: uuid,
    expectedPublicationId: uuid.nullable(),
    manifest: editorialPublicationManifestSchema,
  })
  .strict();

export const editorialWithdrawSchema = z
  .object({ publicationId: uuid })
  .strict();

export type EditorialOperatorResult = {
  publicationId: string;
  slug: string;
  state: "available" | "unavailable" | "withdrawn";
};

const canonicalPublishRequest = (
  input: z.infer<typeof editorialPublishSchema>,
) => ({
  publicationId: input.publicationId,
  expectedPublicationId: input.expectedPublicationId,
  manifest: input.manifest,
});

const PUBLICATION_JOIN = `
  FROM editorial_publications publication
  JOIN shares share ON share.id=publication.share_id
  JOIN revisions revision
    ON revision.id=publication.revision_id
   AND revision.tenant_id=publication.tenant_id
   AND revision.artifact_id=publication.artifact_id
  JOIN artifacts artifact
    ON artifact.id=publication.artifact_id
   AND artifact.tenant_id=publication.tenant_id
  JOIN tenants tenant ON tenant.id=publication.tenant_id
  JOIN accounts account ON account.id=tenant.owner_id
  LEFT JOIN revision_derivatives derivative
    ON derivative.id=publication.derivative_id
   AND derivative.revision_id=publication.revision_id`;

const PUBLICATION_USABLE = `
  publication.withdrawn_at IS NULL
  AND NOT account.disabled
  AND account.deletion_requested_at IS NULL
  AND artifact.trashed_at IS NULL
  AND share.tenant_id=publication.tenant_id
  AND share.artifact_id=publication.artifact_id
  AND share.revision_id=publication.revision_id
  AND share.derivative_id IS NOT DISTINCT FROM publication.derivative_id
  AND NOT share.revoked AND share.expires_at>now()
  AND revision.sha256=publication.source_sha256
  AND revision.manifest_sha256 IS NOT DISTINCT FROM publication.manifest_sha256
  AND (
    (
      publication.derivative_id IS NULL
      AND revision.storage_kind='single'
      AND revision.html_profile IN ('static','limited')
    )
    OR
    (
      $1::boolean
      AND publication.derivative_id IS NOT NULL
      AND revision.storage_kind='bundle'
      AND derivative.state='ready'
      AND derivative.sha256=publication.derivative_sha256
      AND derivative.source_manifest_sha256=revision.manifest_sha256
      AND derivative.builder_version=publication.builder_version
      AND derivative.runtime_profile=publication.runtime_profile
      AND publication.builder_version=ANY($2::text[])
      AND publication.runtime_profile=$3
    )
  )`;

const usableParameters = () => [
  config.HTML_LIVE_ENABLED,
  [...SERVED_BUILDER_VERSIONS],
  BUNDLE_RUNTIME_PROFILE,
];

/**
 * Ordinary unlisted shares keep their existing policy. Once a share has ever
 * been registered in the catalogue, every capability path requires its exact
 * current publication binding to remain usable.
 */
export async function assertEditorialShareAccessible(
  c: Queryable,
  shareId: string,
) {
  const {
    rows: [state],
  } = await c.query(
    `SELECT
       EXISTS(SELECT 1 FROM editorial_publications WHERE share_id=$4) AS bound,
       EXISTS(
         SELECT 1 ${PUBLICATION_JOIN}
         WHERE publication.share_id=$4 AND ${PUBLICATION_USABLE}
       ) AS usable`,
    [...usableParameters(), shareId],
  );
  if (state?.bound && !state.usable) throw missing();
}

const operatorState = async (
  c: Queryable,
  publicationId: string,
): Promise<EditorialOperatorResult> => {
  const {
    rows: [publication],
  } = await c.query(
    `SELECT publication.id,publication.slug,publication.withdrawn_at,
       (${PUBLICATION_USABLE}) AS usable
     ${PUBLICATION_JOIN}
     WHERE publication.id=$4`,
    [...usableParameters(), publicationId],
  );
  if (!publication) throw missing();
  return {
    publicationId: publication.id,
    slug: publication.slug,
    state: publication.withdrawn_at
      ? "withdrawn"
      : publication.usable
        ? "available"
        : "unavailable",
  };
};

const conflict = (message: string) => new Problem(409, "conflict", message);

export async function publishEditorialInTransaction(
  c: PoolClient,
  actor: Actor,
  body: unknown,
) {
  const input = editorialPublishSchema.parse(body);
  if (input.manifest.binding.tenantId !== actor.tenant) throw missing();
  const request = canonicalPublishRequest(input);
  const requestHash = sha256(JSON.stringify(request));
  await lockActiveOwnerTenant(c, actor);

  const existing = (
    await c.query(
      "SELECT tenant_id,request,request_hash FROM editorial_publications WHERE id=$1 FOR UPDATE",
      [input.publicationId],
    )
  ).rows[0];
  if (existing) {
    if (existing.tenant_id !== actor.tenant) throw missing();
    let storedRequest;
    try {
      storedRequest = canonicalPublishRequest(
        editorialPublishSchema.parse(existing.request),
      );
    } catch {
      throw conflict("Сохранённый publication request повреждён.");
    }
    if (
      existing.request_hash !== requestHash ||
      JSON.stringify(storedRequest) !== JSON.stringify(request)
    )
      throw conflict("Этот publication id относится к другому запросу.");
    return operatorState(c, input.publicationId);
  }

  const active = (
    await c.query(
      `SELECT id,tenant_id,artifact_id,share_id FROM editorial_publications
       WHERE slug=$1 AND withdrawn_at IS NULL`,
      [input.manifest.public.slug],
    )
  ).rows[0];
  if (active && active.tenant_id !== actor.tenant) throw missing();
  if ((active?.id ?? null) !== input.expectedPublicationId)
    throw conflict("Публикация с этим slug изменилась.");

  const artifactIds = [
    input.manifest.binding.artifactId,
    ...(active ? [active.artifact_id] : []),
  ].sort();
  await c.query(
    `SELECT id FROM artifacts
     WHERE tenant_id=$1 AND id=ANY($2::uuid[])
     ORDER BY id FOR UPDATE`,
    [actor.tenant, [...new Set(artifactIds)]],
  );
  const shareIds = [
    input.manifest.binding.shareId,
    ...(active ? [active.share_id] : []),
  ].sort();
  await c.query(
    `SELECT id FROM shares
     WHERE tenant_id=$1 AND id=ANY($2::uuid[])
     ORDER BY id FOR UPDATE`,
    [actor.tenant, [...new Set(shareIds)]],
  );
  if (active)
    await c.query(
      "SELECT id FROM editorial_publications WHERE id=$1 FOR UPDATE",
      [active.id],
    );

  const binding = input.manifest.binding;
  const revision = (
    await c.query(
      `SELECT revision.*,artifact.trashed_at,
         derivative.state AS derivative_state,
         derivative.source_manifest_sha256 AS derivative_source_manifest_sha256,
         derivative.builder_version AS derivative_builder_version,
         derivative.runtime_profile AS derivative_runtime_profile,
         derivative.sha256 AS derivative_sha256
       FROM revisions revision
       JOIN artifacts artifact ON artifact.id=revision.artifact_id
         AND artifact.tenant_id=revision.tenant_id
       LEFT JOIN revision_derivatives derivative
         ON derivative.id=$4 AND derivative.revision_id=revision.id
       WHERE revision.id=$1 AND revision.tenant_id=$2 AND revision.artifact_id=$3`,
      [
        binding.revisionId,
        actor.tenant,
        binding.artifactId,
        binding.derivativeId,
      ],
    )
  ).rows[0];
  if (!revision || revision.trashed_at) throw missing();
  if (
    !input.manifest.source.path.endsWith("/index.html") &&
    input.manifest.source.path !== "index.html"
  )
    throw new Problem(
      422,
      "invalid",
      "Editorial source должен указывать на index.html.",
    );
  if (
    revision.sha256 !== binding.sourceSha256 ||
    revision.sha256 !== input.manifest.source.sha256 ||
    revision.manifest_sha256 !== binding.manifestSha256
  )
    throw conflict("Source или manifest hash не совпадает с revision.");
  if (revision.manifest === null) {
    if (binding.manifestSha256 !== null)
      throw conflict("Manifest binding не совпадает с legacy revision.");
  } else {
    let canonicalManifestHash: string;
    try {
      canonicalManifestHash = sha256(
        JSON.stringify(canonicalizeManifest(revision.manifest)),
      );
    } catch {
      throw conflict("Сохранённый manifest не проходит canonical validation.");
    }
    if (
      canonicalManifestHash !== revision.manifest_sha256 ||
      canonicalManifestHash !== binding.manifestSha256
    )
      throw conflict("Canonical manifest hash не совпадает с binding.");
  }

  const share = (
    await c.query(
      `SELECT * FROM shares
       WHERE id=$1 AND tenant_id=$2 AND artifact_id=$3 AND revision_id=$4`,
      [binding.shareId, actor.tenant, binding.artifactId, binding.revisionId],
    )
  ).rows[0];
  if (
    !share ||
    share.revoked ||
    new Date(share.expires_at).getTime() <= Date.now() ||
    share.derivative_id !== binding.derivativeId
  )
    throw missing();
  if (
    (
      await c.query("SELECT 1 FROM editorial_publications WHERE share_id=$1", [
        binding.shareId,
      ])
    ).rowCount
  )
    throw conflict("Эта ссылка уже была зарегистрирована в каталоге.");

  if (revision.storage_kind === "single") {
    if (
      !["static", "limited"].includes(revision.html_profile) ||
      binding.derivativeId !== null
    )
      throw new Problem(
        422,
        "unsupported",
        "Revision нельзя открыть в текущем runtime.",
      );
  } else if (
    revision.storage_kind !== "bundle" ||
    !config.HTML_LIVE_ENABLED ||
    !binding.derivativeId ||
    revision.derivative_state !== "ready" ||
    revision.derivative_source_manifest_sha256 !== revision.manifest_sha256 ||
    revision.derivative_sha256 !== binding.derivativeSha256 ||
    revision.derivative_builder_version !== binding.builderVersion ||
    revision.derivative_runtime_profile !== binding.runtimeProfile ||
    !isServedBuilderVersion(binding.builderVersion) ||
    binding.runtimeProfile !== BUNDLE_RUNTIME_PROFILE
  ) {
    throw new Problem(
      422,
      "unsupported",
      "Revision нельзя открыть в текущем runtime.",
    );
  }

  if (active) {
    await c.query(
      "UPDATE editorial_publications SET withdrawn_at=clock_timestamp() WHERE id=$1",
      [active.id],
    );
    const oldShare = (
      await c.query("SELECT * FROM shares WHERE id=$1", [active.share_id])
    ).rows[0];
    await revokeLockedShareInTransaction(c, actor, oldShare);
    await audit(c, actor, "editorial.withdrawn", active.id);
  }

  await c.query(
    `INSERT INTO editorial_publications(
       id,slug,tenant_id,artifact_id,revision_id,share_id,derivative_id,
       source_sha256,manifest_sha256,derivative_sha256,builder_version,
       runtime_profile,metadata,request,request_hash
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      input.publicationId,
      input.manifest.public.slug,
      actor.tenant,
      binding.artifactId,
      binding.revisionId,
      binding.shareId,
      binding.derivativeId,
      binding.sourceSha256,
      binding.manifestSha256,
      binding.derivativeSha256,
      binding.builderVersion,
      binding.runtimeProfile,
      input.manifest.public,
      request,
      requestHash,
    ],
  );
  await audit(c, actor, "editorial.published", input.publicationId);
  return operatorState(c, input.publicationId);
}

export async function publishEditorial(actor: Actor, body: unknown) {
  return transaction((c) => publishEditorialInTransaction(c, actor, body));
}

export async function withdrawEditorialInTransaction(
  c: PoolClient,
  actor: Actor,
  body: unknown,
) {
  const { publicationId } = editorialWithdrawSchema.parse(body);
  await lockActiveOwnerTenant(c, actor);
  const candidate = (
    await c.query(
      `SELECT id,artifact_id,share_id,withdrawn_at
       FROM editorial_publications WHERE id=$1 AND tenant_id=$2`,
      [publicationId, actor.tenant],
    )
  ).rows[0];
  if (!candidate) throw missing();
  if (candidate.withdrawn_at) return operatorState(c, publicationId);
  await c.query(
    "SELECT id FROM artifacts WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
    [candidate.artifact_id, actor.tenant],
  );
  const share = (
    await c.query(
      "SELECT * FROM shares WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [candidate.share_id, actor.tenant],
    )
  ).rows[0];
  await c.query(
    "SELECT id FROM editorial_publications WHERE id=$1 FOR UPDATE",
    [publicationId],
  );
  await c.query(
    "UPDATE editorial_publications SET withdrawn_at=clock_timestamp() WHERE id=$1",
    [publicationId],
  );
  await revokeLockedShareInTransaction(c, actor, share);
  await audit(c, actor, "editorial.withdrawn", publicationId);
  return operatorState(c, publicationId);
}

export async function withdrawEditorial(actor: Actor, body: unknown) {
  return transaction((c) => withdrawEditorialInTransaction(c, actor, body));
}

/** Account deletion has already locked this tenant's shares/publications. */
export async function withdrawEditorialForDeletionInTransaction(
  c: PoolClient,
  actor: Actor,
) {
  await c.query(
    `UPDATE editorial_publications
     SET withdrawn_at=clock_timestamp()
     WHERE tenant_id=$1 AND withdrawn_at IS NULL`,
    [actor.tenant],
  );
}

const publicRows = async (
  slug?: string,
): Promise<EditorialPublicResponse[]> => {
  const values: unknown[] = [...usableParameters()];
  const slugCondition = slug ? "AND publication.slug=$4" : "";
  if (slug) values.push(slug);
  const rows = (
    await db.query(
      `SELECT publication.metadata,publication.published_at,publication.share_id
       ${PUBLICATION_JOIN}
       WHERE ${PUBLICATION_USABLE} ${slugCondition}
       ORDER BY publication.published_at DESC,publication.id DESC
       LIMIT 20`,
      values,
    )
  ).rows;
  return rows.map((row) => ({
    ...editorialPublicMetadataSchema.parse(row.metadata),
    publishedAt: new Date(row.published_at).toISOString(),
    recipientUrl: `${config.APP_ORIGIN}/s#${tokenFor(row.share_id)}`,
  }));
};

export async function listEditorial() {
  return { items: await publicRows() };
}

export async function getEditorial(slug: string) {
  const item = (await publicRows(slug))[0];
  if (!item) throw missing();
  return item;
}
