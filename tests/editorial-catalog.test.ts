import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import {
  publishEditorial,
  withdrawEditorial,
} from "../apps/server/editorial.ts";
import { Problem } from "../apps/server/errors.ts";
import { createLiveViewerApp } from "../apps/server/live-viewer.ts";
import { publishOwnerShare } from "../apps/server/shares.ts";
import { s3, sha256 } from "../apps/server/storage.ts";
import { prepareCapture } from "../scripts/prepare-capture.ts";

if (!["127.0.0.1", "localhost"].includes(new URL(config.APP_ORIGIN).hostname))
  throw new Error("Editorial tests require a loopback installation");
if (!config.HTML_LIVE_ENABLED)
  throw new Error("Run editorial-catalog.test.ts with HTML_LIVE_ENABLED=true");

const app = await createApp();
const viewer = await createLiveViewerApp();
const password = randomBytes(24).toString("hex");
let owner: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;
let cookie = "";
let otherCookie = "";

async function call(
  method: any,
  url: string,
  body?: any,
  session = cookie,
  authorization?: string,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.APP_ORIGIN,
      ...(session ? { cookie: session } : {}),
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      ...(Buffer.isBuffer(body)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    payload: body,
  });
}

async function catalogueHas(slug: string) {
  const response = await call("GET", "/api/editorial", undefined, "");
  assert.equal(response.statusCode, 200, response.body);
  return response.json().items.some((item: any) => item.slug === slug);
}

async function saveHtml(
  source: string,
  existing?: { artifactId: string; revisionId: string },
  session = cookie,
) {
  const bytes = Buffer.from(source);
  const begun = await call(
    "POST",
    "/api/uploads",
    {
      key: randomUUID(),
      title: "Editorial fixture",
      filename: "index.html",
      mime: "text/html",
      size: bytes.length,
      sha256: sha256(bytes),
      ...(existing
        ? {
            artifactId: existing.artifactId,
            baseRevisionId: existing.revisionId,
          }
        : {}),
    },
    session,
  );
  assert.equal(begun.statusCode, 200, begun.body);
  const { uploadId } = begun.json();
  const uploaded = await call(
    "PUT",
    `/api/uploads/${uploadId}/bytes`,
    bytes,
    session,
  );
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const finalized = await call(
    "POST",
    `/api/uploads/${uploadId}/finalize`,
    {},
    session,
  );
  assert.equal(finalized.statusCode, 200, finalized.body);
  return { ...finalized.json(), bytes } as any;
}

async function saveBundle() {
  const prepared = await prepareCapture(
    "tests/fixtures/bundle-corpus/team-report",
    "index.html",
    ["index.html", "assets/report.css", "assets/report.js", "assets/mark.svg"],
  );
  const begun = await call("POST", "/api/bundle-uploads", {
    key: randomUUID(),
    title: "Editorial bundle fixture",
    manifest: prepared.manifest,
  });
  assert.equal(begun.statusCode, 200, begun.body);
  const { uploadId, manifest } = begun.json();
  for (const [index, file] of manifest.files.entries()) {
    const payload = prepared.files.find((item) => item.path === file.path)!;
    const uploaded = await call(
      "PUT",
      `/api/bundle-uploads/${uploadId}/files/${index}`,
      Buffer.from(payload.data, payload.encoding),
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
  }
  const finalized = await call(
    "POST",
    `/api/bundle-uploads/${uploadId}/finalize`,
    {},
  );
  assert.equal(finalized.statusCode, 200, finalized.body);
  const built = await call(
    "POST",
    `/api/revisions/${finalized.json().revisionId}/build-inline`,
    {},
  );
  assert.equal(built.statusCode, 200, built.body);
  assert.equal(built.json().state, "ready");
  return finalized.json() as any;
}

async function enableShare(saved: any, session = cookie) {
  const response = await call(
    "POST",
    `/api/artifacts/${saved.artifactId}/share`,
    { expectedRevisionId: saved.revisionId, expiresInDays: 7 },
    session,
  );
  assert.equal(response.statusCode, 200, response.body);
  return response.json().share as any;
}

const publicationInput = async (
  saved: any,
  share: any,
  publicationId = randomUUID(),
  expectedPublicationId: string | null = null,
  slug = `catalog-${randomBytes(4).toString("hex")}`,
  publicationOwner = owner,
  session = cookie,
) => {
  const artifact = (
    await call("GET", `/api/artifacts/${saved.artifactId}`, undefined, session)
  ).json();
  const derivative =
    artifact.revision.storageKind === "bundle"
      ? (
          await db.query(
            "SELECT id,sha256,builder_version,runtime_profile FROM revision_derivatives WHERE revision_id=$1 AND state='ready'",
            [saved.revisionId],
          )
        ).rows[0]
      : null;
  return {
    publicationId,
    expectedPublicationId,
    manifest: {
      version: 1,
      public: {
        slug,
        title: "Редакционный тест",
        topic: "Проверка",
        task: "Проверить точную опубликованную версию",
        action: "Открыть материал",
        author: "Редакция Полки",
        license: "Apache-2.0",
        notices: "Оригинальный синтетический материал для integration test.",
      },
      source: {
        path: `content/editorial/${slug}/index.html`,
        commit: null,
        sha256: saved.sha256,
      },
      runtimeProof: {
        originalRevisionId: saved.revisionId,
        originalSha256: saved.sha256,
        originalManifestSha256: artifact.revision.manifestSha256,
        derivative: derivative
          ? {
              id: derivative.id,
              sha256: derivative.sha256,
              runtimeProfile: derivative.runtime_profile,
              builderVersion: derivative.builder_version,
            }
          : null,
        checkedAt: new Date().toISOString(),
        evidencePath: "docs/reviews/2026-09-21-editorial-runtime/README.md",
      },
      binding: {
        tenantId: publicationOwner.tenant,
        artifactId: saved.artifactId,
        revisionId: saved.revisionId,
        shareId: share.id,
        sourceSha256: saved.sha256,
        manifestSha256: artifact.revision.manifestSha256,
        derivativeId: derivative?.id ?? null,
        derivativeSha256: derivative?.sha256 ?? null,
        builderVersion: derivative?.builder_version ?? null,
        runtimeProfile: derivative?.runtime_profile ?? null,
      },
    },
  };
};

before(async () => {
  const suffix = randomBytes(5).toString("hex");
  owner = await createAccount(`editor-${suffix}`, password);
  other = await createAccount(`editor-other-${suffix}`, password);
  const login = await call(
    "POST",
    "/api/login",
    { name: owner.name, password },
    "",
  );
  assert.equal(login.statusCode, 200, login.body);
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  const otherLogin = await call(
    "POST",
    "/api/login",
    { name: other.name, password },
    "",
  );
  assert.equal(otherLogin.statusCode, 200, otherLogin.body);
  otherCookie = `${otherLogin.cookies[0].name}=${otherLogin.cookies[0].value}`;
});

after(async () => {
  let cleanupError: unknown;
  try {
    if (owner && other) {
      await db.query(
        "UPDATE accounts SET disabled=false WHERE id=ANY($1::uuid[])",
        [[owner.id, other.id]],
      );
      const publications = (
        await db.query(
          `SELECT id,tenant_id FROM editorial_publications
           WHERE tenant_id=ANY($1::uuid[]) AND withdrawn_at IS NULL`,
          [[owner.tenant, other.tenant]],
        )
      ).rows;
      for (const publication of publications) {
        const account = publication.tenant_id === owner.tenant ? owner : other;
        await withdrawEditorial(
          { id: account.id, tenant: account.tenant },
          { publicationId: publication.id },
        );
      }
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    try {
      if (owner && other) {
        await db.query(
          "UPDATE shares SET revoked=true WHERE tenant_id=ANY($1::uuid[])",
          [[owner.tenant, other.tenant]],
        );
        await db.query(
          "UPDATE accounts SET disabled=true WHERE id=ANY($1::uuid[])",
          [[owner.id, other.id]],
        );
        const available = Number(
          (
            await db.query(
              `SELECT count(*) FROM editorial_publications publication
               JOIN shares share ON share.id=publication.share_id
               JOIN tenants tenant ON tenant.id=publication.tenant_id
               JOIN accounts account ON account.id=tenant.owner_id
               JOIN artifacts artifact ON artifact.id=publication.artifact_id
               WHERE publication.tenant_id=ANY($1::uuid[])
                 AND publication.withdrawn_at IS NULL
                 AND NOT share.revoked AND share.expires_at>now()
                 AND NOT account.disabled AND artifact.trashed_at IS NULL`,
              [[owner.tenant, other.tenant]],
            )
          ).rows[0].count,
        );
        assert.equal(available, 0);
      }
    } catch (fallbackError) {
      cleanupError ??= fallbackError;
    }
    await Promise.allSettled([app.close(), viewer.close()]);
    await db.end();
    s3.destroy();
  }
  if (cleanupError) throw cleanupError;
});

test("catalogue pins an explicit share, is idempotent, and closes every recipient path", async () => {
  const v1 = await saveHtml(
    "<!doctype html><title>Editorial v1</title><main>Exact accepted source for the public catalogue.</main>",
  );
  const share1 = await enableShare(v1);
  const token1 = new URL(share1.url).hash.slice(1);
  const input1 = await publicationInput(v1, share1);
  const actor = { id: owner.id, tenant: owner.tenant };

  assert.deepEqual(await publishEditorial(actor, input1), {
    publicationId: input1.publicationId,
    slug: input1.manifest.public.slug,
    state: "available",
  });
  assert.deepEqual(await publishEditorial(actor, input1), {
    publicationId: input1.publicationId,
    slug: input1.manifest.public.slug,
    state: "available",
  });
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM audit_outbox WHERE action='editorial.published' AND target_id=$1",
          [input1.publicationId],
        )
      ).rows[0].count,
    ),
    1,
  );

  const otherSaved = await saveHtml(
    "<!doctype html><title>Other tenant</title><main>A valid source owned by another isolated tenant.</main>",
    undefined,
    otherCookie,
  );
  const otherShare = await enableShare(otherSaved, otherCookie);
  const takeover = await publicationInput(
    otherSaved,
    otherShare,
    randomUUID(),
    input1.publicationId,
    input1.manifest.public.slug,
    other,
    otherCookie,
  );
  await assert.rejects(
    publishEditorial({ id: other.id, tenant: other.tenant }, takeover),
    (error: unknown) => error instanceof Problem && error.status === 404,
  );
  const ownerPublication = (
    await db.query(
      `SELECT publication.withdrawn_at,share.revoked
       FROM editorial_publications publication
       JOIN shares share ON share.id=publication.share_id
       WHERE publication.id=$1`,
      [input1.publicationId],
    )
  ).rows[0];
  assert.equal(ownerPublication.withdrawn_at, null);
  assert.equal(ownerPublication.revoked, false);
  await assert.rejects(
    publishEditorial(actor, {
      ...input1,
      manifest: {
        ...input1.manifest,
        public: { ...input1.manifest.public, title: "Changed retry" },
      },
    }),
    (error: unknown) => error instanceof Problem && error.status === 409,
  );

  const listing = await call("GET", "/api/editorial", undefined, "");
  assert.equal(listing.statusCode, 200, listing.body);
  const listed = listing
    .json()
    .items.find((item: any) => item.slug === input1.manifest.public.slug);
  assert.ok(listed);
  const publicText = JSON.stringify(listing.json());
  for (const secret of [
    owner.tenant,
    v1.artifactId,
    v1.revisionId,
    share1.id,
    input1.manifest.runtimeProof.evidencePath,
  ])
    assert.equal(publicText.includes(secret), false);
  const detail = await call(
    "GET",
    `/api/editorial/${input1.manifest.public.slug}`,
    undefined,
    "",
  );
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().recipientUrl, listed.recipientUrl);

  const resolved1 = await call("POST", "/api/resolve", { token: token1 }, "");
  assert.equal(resolved1.statusCode, 200, resolved1.body);
  assert.equal(resolved1.json().revision.id, v1.revisionId);
  const grant1 = resolved1.json().grant;
  const recipientBytes = await call(
    "GET",
    "/api/view/bytes",
    undefined,
    "",
    grant1,
  );
  assert.deepEqual(recipientBytes.rawPayload, v1.bytes);
  const ownerBytes = await call("GET", `/api/revisions/${v1.revisionId}/bytes`);
  assert.deepEqual(ownerBytes.rawPayload, v1.bytes);

  const v2 = await saveHtml(
    "<!doctype html><title>Editorial v2</title><main>A later version is not silently published.</main>",
    { artifactId: v1.artifactId, revisionId: v1.revisionId },
  );
  await assert.rejects(
    publishOwnerShare(actor, share1.id, {
      revisionId: v2.revisionId,
      expectedPublishedRevisionId: v1.revisionId,
    }),
    (error: unknown) => error instanceof Problem && error.status === 409,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/api/editorial/${input1.manifest.public.slug}`,
        undefined,
        "",
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await call("POST", "/api/resolve", { token: token1 }, "")).json().revision
      .id,
    v1.revisionId,
  );

  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [owner.id]);
  assert.equal(await catalogueHas(input1.manifest.public.slug), false);
  assert.equal(
    (
      await call(
        "GET",
        `/api/editorial/${input1.manifest.public.slug}`,
        undefined,
        "",
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await call("POST", "/api/resolve", { token: token1 }, "")).statusCode,
    404,
  );
  assert.equal(
    (await call("GET", "/api/view/bytes", undefined, "", grant1)).statusCode,
    404,
  );
  await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [owner.id]);

  const trashed = await call("POST", `/api/artifacts/${v1.artifactId}/trash`, {
    expectedRevisionId: v2.revisionId,
    expectedLifecycleVersion: 0,
  });
  assert.equal(trashed.statusCode, 200, trashed.body);
  assert.equal(await catalogueHas(input1.manifest.public.slug), false);
  const restored = await call(
    "POST",
    `/api/artifacts/${v1.artifactId}/restore`,
    { expectedRevisionId: v2.revisionId, expectedLifecycleVersion: 1 },
  );
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(await catalogueHas(input1.manifest.public.slug), false);

  const share2 = await enableShare(v2);
  const token2 = new URL(share2.url).hash.slice(1);
  const input2 = await publicationInput(
    v2,
    share2,
    randomUUID(),
    input1.publicationId,
    input1.manifest.public.slug,
  );
  assert.equal((await publishEditorial(actor, input2)).state, "available");
  assert.equal(
    (
      await db.query(
        "SELECT withdrawn_at IS NOT NULL AS withdrawn FROM editorial_publications WHERE id=$1",
        [input1.publicationId],
      )
    ).rows[0].withdrawn,
    true,
  );
  assert.equal(
    (await call("POST", "/api/resolve", { token: token1 }, "")).statusCode,
    404,
  );
  const resolved2 = await call("POST", "/api/resolve", { token: token2 }, "");
  assert.equal(resolved2.statusCode, 200, resolved2.body);
  assert.equal(resolved2.json().revision.id, v2.revisionId);

  assert.equal(
    (await withdrawEditorial(actor, { publicationId: input2.publicationId }))
      .state,
    "withdrawn",
  );
  assert.equal(
    (await withdrawEditorial(actor, { publicationId: input2.publicationId }))
      .state,
    "withdrawn",
  );
  assert.equal(await catalogueHas(input1.manifest.public.slug), false);
  assert.equal(
    (await call("POST", "/api/resolve", { token: token2 }, "")).statusCode,
    404,
  );
});

test("catalogue validates and gates a ready bundle derivative through the live viewer", async () => {
  const saved = await saveBundle();
  const share = await enableShare(saved);
  const token = new URL(share.url).hash.slice(1);
  const input = await publicationInput(saved, share);
  const actor = { id: owner.id, tenant: owner.tenant };

  const wrongHash = "f".repeat(64);
  await assert.rejects(
    publishEditorial(actor, {
      ...input,
      publicationId: randomUUID(),
      manifest: {
        ...input.manifest,
        runtimeProof: {
          ...input.manifest.runtimeProof,
          derivative: {
            ...input.manifest.runtimeProof.derivative!,
            sha256: wrongHash,
          },
        },
        binding: {
          ...input.manifest.binding,
          derivativeSha256: wrongHash,
        },
      },
    }),
    (error: unknown) => error instanceof Problem && error.status === 422,
  );
  await assert.rejects(
    publishEditorial(actor, {
      ...input,
      publicationId: randomUUID(),
      manifest: {
        ...input.manifest,
        runtimeProof: {
          ...input.manifest.runtimeProof,
          derivative: {
            ...input.manifest.runtimeProof.derivative!,
            runtimeProfile: "outdated-profile",
          },
        },
        binding: {
          ...input.manifest.binding,
          runtimeProfile: "outdated-profile",
        },
      },
    }),
    (error: unknown) => error instanceof Problem && error.status === 422,
  );
  config.HTML_LIVE_ENABLED = false;
  try {
    await assert.rejects(
      publishEditorial(actor, { ...input, publicationId: randomUUID() }),
      (error: unknown) => error instanceof Problem && error.status === 422,
    );
  } finally {
    config.HTML_LIVE_ENABLED = true;
  }

  assert.equal((await publishEditorial(actor, input)).state, "available");
  const persisted = (
    await db.query("SELECT request FROM editorial_publications WHERE id=$1", [
      input.publicationId,
    ])
  ).rows[0].request;
  assert.equal(persisted.manifest.source.path, input.manifest.source.path);
  assert.equal(
    persisted.manifest.runtimeProof.evidencePath,
    input.manifest.runtimeProof.evidencePath,
  );

  const resolved = await call("POST", "/api/resolve", { token }, "");
  assert.equal(resolved.statusCode, 200, resolved.body);
  const launched = await call(
    "POST",
    "/api/view/live-view",
    {},
    "",
    resolved.json().grant,
  );
  assert.equal(launched.statusCode, 200, launched.body);
  const viewerToken = new URL(launched.json().url).pathname.split("/").at(-1)!;
  const embedded = () =>
    viewer.inject({
      method: "GET",
      url: `/document/${viewerToken}`,
      headers: { host: config.VIEWER_UPSTREAM_HOST, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
    });
  assert.equal((await embedded()).statusCode, 200);

  config.HTML_LIVE_ENABLED = false;
  try {
    assert.equal((await embedded()).statusCode, 404);
    assert.equal(await catalogueHas(input.manifest.public.slug), false);
  } finally {
    config.HTML_LIVE_ENABLED = true;
  }
  assert.equal((await embedded()).statusCode, 200);

  await db.query("UPDATE accounts SET disabled=true WHERE id=$1", [owner.id]);
  assert.equal((await embedded()).statusCode, 404);
  await db.query("UPDATE accounts SET disabled=false WHERE id=$1", [owner.id]);
  assert.equal((await embedded()).statusCode, 200);

  const revoked = await call("POST", `/api/shares/${share.id}/revoke`, {});
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await embedded()).statusCode, 404);
  assert.equal(
    (
      await call(
        "GET",
        `/api/editorial/${input.manifest.public.slug}`,
        undefined,
        "",
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await withdrawEditorial(actor, { publicationId: input.publicationId }))
      .state,
    "withdrawn",
  );
  assert.equal((await embedded()).statusCode, 404);
});

test("publication rejects another tenant and source hash mismatch without a row", async () => {
  const saved = await saveHtml(
    "<!doctype html><title>Rejected</title><main>This source remains private after a rejected publication.</main>",
  );
  const share = await enableShare(saved);
  const input = await publicationInput(saved, share);
  await assert.rejects(
    publishEditorial({ id: other.id, tenant: other.tenant }, input),
    (error: unknown) => error instanceof Problem && error.status === 404,
  );
  const badHash = "0".repeat(64);
  const mismatched = {
    ...input,
    publicationId: randomUUID(),
    manifest: {
      ...input.manifest,
      source: { ...input.manifest.source, sha256: badHash },
      runtimeProof: {
        ...input.manifest.runtimeProof,
        originalSha256: badHash,
      },
      binding: { ...input.manifest.binding, sourceSha256: badHash },
    },
  };
  await assert.rejects(
    publishEditorial({ id: owner.id, tenant: owner.tenant }, mismatched),
    (error: unknown) => error instanceof Problem && error.status === 409,
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM editorial_publications WHERE id=ANY($1::uuid[])",
          [[input.publicationId, mismatched.publicationId]],
        )
      ).rows[0].count,
    ),
    0,
  );
});
