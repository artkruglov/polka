import { shelfSnapshotForMember } from "./shelf-snapshot.ts";
import { acceptRevision, setWorkOwner } from "./artifact-acceptance.ts";
import { proposeToFeed, readFeedProposal, withdrawFeedProposal } from "./feed-proposals.ts";
import {
  HEADLINE_OPTIONS,
  searchJoin,
  searchMatch,
  searchQuery,
  searchRank,
  searchSnippet,
  titlePattern,
} from "./search-text.ts";
import { z } from "zod";
import { db } from "./db.ts";
import { assertStrongSession, identity, limitAttempts } from "./auth.ts";
import { Problem, missing } from "./errors.ts";
import {
  abortUpload,
  beginBundleUpload,
  beginUpload,
  finalizeBundleUpload,
  finalizeUpload,
  getArtifact,
  getArtifacts,
  revisionDTO,
  uploadBundleFile,
  uploadBytes,
  uploadStatus,
} from "./artifacts.ts";
import { readBlob } from "./storage.ts";
import { inlineBuildSelect } from "./bundle-derivatives.ts";
import { LINK_MIME, uuid } from "../../packages/contracts/index.ts";
import { saveLink } from "./saved-links.ts";
import { readLinkDocument } from "./saved-link-format.ts";
import { updateArtifactMetadata } from "./artifact-metadata.ts";
import { transitionOwnerArtifactLifecycle } from "./artifact-trash.ts";
import { deleteArtifactForever } from "./artifact-purge.ts";
import type { FastifyInstance } from "fastify";
import { SHELF, id } from "./route-helpers.ts";

/** Concurrent upload bodies: server-wide and per shelf. */
export const TRANSFER_SLOTS = { total: 4, perTenant: 3 };

// Shelf and trash pages continue from a microsecond (timestamp,id) pair.
const pageCursor = z.object({ date: z.string().datetime(), id: uuid });
function decodeCursor(value: string | undefined, message: string) {
  if (!value) return null;
  try {
    return pageCursor.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
  } catch {
    throw new Problem(400, "invalid", message);
  }
}
const encodeCursor = (date: string, id: string) => Buffer.from(JSON.stringify({ date, id })).toString("base64url");

/**
 * What a shelf chip groups by, from the latest version's MIME type (stored
 * on the work, artifacts.latest_mime); mirrors categoryOf in
 * apps/web/src/entities/artifact/format.ts.
 */
const SHELF_KINDS = ["pages", "documents", "images", "other"] as const;
type ShelfKind = (typeof SHELF_KINDS)[number];
const shelfKindSql = (artifact: string) =>
  `(CASE WHEN ${artifact}.latest_mime LIKE 'image/%' THEN 'images'
         WHEN ${artifact}.latest_mime IN ('text/plain','text/markdown') THEN 'documents'
         WHEN ${artifact}.latest_mime='text/html' THEN 'pages'
         ELSE 'other' END)`;
/**
 * The matching works (`matched`) with their rank for «Сначала подходящие».
 * OFFSET 0 keeps the subquery whole, so the rank (the text's cover density,
 * the costly part of a ranked search) is computed once per work rather than
 * again for the page key and for the order.
 */
const RANKED = `(SELECT artifact.*,${searchRank("artifact", "$3", "$6")} AS search_rank
                 FROM matched artifact ${searchJoin("artifact")} OFFSET 0)`;
const UPDATED_KEY = `to_char(artifact.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** The shelf's orders: the key a page ends on, the ORDER BY, and «after the key». */
const SHELF_ORDER = {
  new: {
    key: UPDATED_KEY,
    by: "artifact.updated_at DESC,artifact.id DESC",
    after: (key: string, id: string) => `(artifact.updated_at,artifact.id)<(${key}::timestamptz,${id})`,
  },
  old: {
    key: UPDATED_KEY,
    by: "artifact.updated_at ASC,artifact.id ASC",
    after: (key: string, id: string) => `(artifact.updated_at,artifact.id)>(${key}::timestamptz,${id})`,
  },
  title: {
    key: "lower(artifact.title)",
    by: "lower(artifact.title) ASC,artifact.id ASC",
    after: (key: string, id: string) => `(lower(artifact.title),artifact.id)>(${key},${id})`,
  },
  // A search, best answers first (searchRank over $3 and $6 of the shelf's
  // query, as search_rank: RANKED), then newest. The key is «rank date»;
  // without a query, newest first.
  relevance: {
    key: `artifact.search_rank::text||' '||${UPDATED_KEY}`,
    by: `artifact.search_rank DESC,artifact.updated_at DESC,artifact.id DESC`,
    after: (key: string, id: string) =>
      `(artifact.search_rank,artifact.updated_at,artifact.id)<(split_part(${key},' ',1)::int,split_part(${key},' ',2)::timestamptz,${id})`,
  },
} as const;
type ShelfOrder = keyof typeof SHELF_ORDER;
const listCursor = z.object({
  sort: z.enum(["new", "old", "title", "relevance"]),
  key: z.string().max(600),
  id: uuid,
});
function decodeListCursor(value: string | undefined, sort: ShelfOrder) {
  if (!value) return null;
  try {
    const raw = JSON.parse(Buffer.from(value, "base64url").toString());
    // A page loaded before orders existed carries { date, id }: newest first.
    const legacy = pageCursor.safeParse(raw);
    const cursor = legacy.success
      ? { sort: "new" as const, key: legacy.data.date, id: legacy.data.id }
      : listCursor.parse(raw);
    if (cursor.sort !== sort) throw Error("another order");
    if (sort === "relevance") {
      const [rank, date, ...rest] = cursor.key.split(" ");
      if (!/^\d{1,8}$/.test(rank) || rest.length) throw Error("a rank and a date");
      z.string().datetime().parse(date);
    } else if (sort !== "title") z.string().datetime().parse(cursor.key);
    return cursor;
  } catch {
    throw new Problem(400, "invalid", "Обновите список: указатель страницы некорректен.");
  }
}
const encodeListCursor = (sort: ShelfOrder, key: string, id: string) =>
  Buffer.from(JSON.stringify({ sort, key, id })).toString("base64url");

/** Works on the shelf: listing, trash, metadata, revisions and uploads. */
export function registerWorkRoutes(app: FastifyInstance) {
  app.get("/api/artifacts", async (req) => {
    const actor = await identity(req, SHELF);
    const q = z
      .object({
        q: z.string().max(160).default(""),
        folderId: uuid.optional(),
        cursor: z.string().max(800).optional(),
        // The whole shelf in this order and of this kind, not the loaded page.
        sort: z.enum(["new", "old", "title", "relevance"]).default("new"),
        kind: z.enum(SHELF_KINDS).optional(),
        // Only works with a version a curator accepted.
        accepted: z.literal("1").optional(),
      })
      .parse(req.query);
    const order = SHELF_ORDER[q.sort];
    const cursor = decodeListCursor(q.cursor, q.sort);
    // By title or by the text of the latest version (docs/specs/CONTENT_SEARCH.md).
    const text = q.q.trim();
    const title = titlePattern(text);
    // The works that match, once: the page is read from them, and the first
    // page also counts them by kind over the whole shelf (the chips). Read
    // twice, the CTE is computed once; a later page reads it once, inlined,
    // in the order of the shelf's index.
    const matched = `
      SELECT artifact.id,artifact.title,artifact.title_document,artifact.updated_at,
             artifact.latest_revision_id,${shelfKindSql("artifact")} AS kind
        FROM artifacts artifact
       WHERE artifact.tenant_id=$1 AND artifact.trashed_at IS NULL
         AND ($2::uuid IS NULL OR artifact.folder_id=$2)
         AND ${searchMatch("artifact", "$3", "$6", "ARRAY[$1::uuid]")}
         AND ($9::boolean IS NOT TRUE OR artifact.accepted_revision_id IS NOT NULL)`;
    const countsSql = `(SELECT json_object_agg(kind,count) FROM (SELECT kind,count(*)::int AS count FROM matched GROUP BY 1) kinds)`;
    const params = [
      actor.tenant,
      q.folderId ?? null,
      title,
      cursor?.key ?? null,
      cursor?.id ?? null,
      searchQuery(text),
      HEADLINE_OPTIONS,
      q.kind ?? null,
      q.accepted === "1",
    ];
    const list = (values: unknown[]) =>
      db.query(
        // The page first, then the text of its 25 works for the snippets;
        // only «Сначала подходящие» reads the text of every match (its rank).
        `WITH matched AS (${matched})
         SELECT artifact.id,artifact.cursor_key,
                ${searchSnippet("$6", "$7")}${cursor ? "" : `,${countsSql} AS counts`}
         FROM (SELECT artifact.*,${order.key} AS cursor_key
                 FROM ${q.sort === "relevance" ? RANKED : "matched"} artifact
                WHERE ($8::text IS NULL OR artifact.kind=$8)
                  AND ($4::text IS NULL OR ${order.after("$4", "$5::uuid")})
                ORDER BY ${order.by} LIMIT 25) artifact
         ${searchJoin("artifact")}
         ORDER BY ${order.by}`,
        values,
      );
    const { rows } = await list(params);
    const more = rows.length > 24,
      page = rows.slice(0, 24),
      last = page.at(-1);
    // How many works of each kind match, over the whole shelf (first page
    // only), from the same statement. A page empty for its kind asks again
    // without the kind (rare); with no kind chosen, empty means none match.
    let counts: Record<ShelfKind | "all", number> | undefined;
    if (!cursor) {
      counts = { all: 0, pages: 0, documents: 0, images: 0, other: 0 };
      const first = rows[0] ?? (q.kind ? (await list(params.with(7, null))).rows[0] : undefined);
      for (const [kind, count] of Object.entries(first?.counts ?? {}) as [ShelfKind, number][]) {
        counts[kind] += count;
        counts.all += count;
      }
    }
    const snippets = new Map<string, string>(
      page.filter((row) => row.search_snippet).map((row) => [row.id, row.search_snippet]),
    );
    const items = (
      await getArtifacts(
        actor,
        page.map((artifact) => artifact.id),
      )
    )
      .filter((artifact) => artifact.trashedAt === null)
      .map((artifact) => (snippets.has(artifact.id) ? { ...artifact, snippet: snippets.get(artifact.id) } : artifact));
    return {
      items,
      nextCursor: more ? encodeListCursor(q.sort, last.cursor_key, last.id) : null,
      ...(counts && { counts }),
    };
  });
  app.get("/api/artifacts/:id", async (req) => getArtifact(await identity(req, SHELF), id(req)));
  // «Полка на дату» (docs/specs/SHELF_SNAPSHOT.md): the shelf the page shows, read-only.
  app.get("/api/snapshot", async (req) =>
    shelfSnapshotForMember(await identity(req, SHELF), (req.query ?? {}) as never),
  );
  app.get("/api/trash", async (req) => {
    const actor = await identity(req, SHELF);
    const query = z
      .object({ cursor: z.string().max(200).optional() })
      .strict()
      .parse(req.query);
    const cursor = decodeCursor(query.cursor, "Обновите корзину: указатель страницы некорректен.");
    const { rows } = await db.query(
      `SELECT id,
              to_char(trashed_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_trashed_at
       FROM artifacts
       WHERE tenant_id=$1 AND trashed_at IS NOT NULL AND purged_at IS NULL
         AND ($2::timestamptz IS NULL OR (trashed_at,id)<($2,$3::uuid))
       ORDER BY trashed_at DESC,id DESC LIMIT 25`,
      [actor.tenant, cursor?.date ?? null, cursor?.id ?? null],
    );
    const more = rows.length > 24;
    const page = rows.slice(0, 24);
    const last = page.at(-1);
    const items = (
      await getArtifacts(
        actor,
        page.map((artifact) => artifact.id),
      )
    ).filter((artifact) => artifact.trashedAt !== null);
    return {
      items,
      nextCursor: more && last ? encodeCursor(last.cursor_trashed_at, last.id) : null,
    };
  });
  app.post("/api/artifacts/:id/trash", async (req) =>
    transitionOwnerArtifactLifecycle(await identity(req, SHELF), id(req), req.body, "trashed"),
  );
  // Delete a trashed work for good (docs/specs/WORK_DELETION.md).
  app.post("/api/artifacts/:id/purge", { bodyLimit: 1024 }, async (req) =>
    deleteArtifactForever(await identity(req, SHELF), id(req), req.body),
  );
  app.post("/api/artifacts/:id/restore", async (req) =>
    transitionOwnerArtifactLifecycle(await identity(req, SHELF), id(req), req.body, "active"),
  );
  // A curator marks the accepted version and names who answers for the work.
  app.put("/api/artifacts/:id/accepted", { bodyLimit: 1024 }, async (req) => {
    const actor = await identity(req, SHELF);
    assertStrongSession(actor);
    return acceptRevision(actor, id(req), req.body);
  });
  // Proposals to «Лента» from a department shelf (feed-proposals.ts).
  app.get("/api/artifacts/:id/feed-proposal", async (req) => readFeedProposal(await identity(req, SHELF), id(req)));
  app.post("/api/artifacts/:id/feed-proposal", { bodyLimit: 2048 }, async (req) => {
    const actor = await identity(req, SHELF);
    assertStrongSession(actor);
    return proposeToFeed(actor, id(req), req.body);
  });
  app.post("/api/artifacts/:id/feed-proposal/withdraw", async (req) => {
    const actor = await identity(req, SHELF);
    assertStrongSession(actor);
    return withdrawFeedProposal(actor, id(req));
  });
  app.put("/api/artifacts/:id/owner", { bodyLimit: 1024 }, async (req) => {
    const actor = await identity(req, SHELF);
    assertStrongSession(actor);
    return setWorkOwner(actor, id(req), req.body);
  });
  app.patch("/api/artifacts/:id", async (req) => updateArtifactMetadata(await identity(req, SHELF), id(req), req.body));
  app.get("/api/artifacts/:id/revisions", async (req) => {
    const actor = await identity(req, SHELF);
    await getArtifact(actor, id(req));
    return (
      await db.query(
        `SELECT r.*,${inlineBuildSelect}
         FROM revisions r WHERE artifact_id=$1 ORDER BY number DESC LIMIT 100`,
        [id(req)],
      )
    ).rows.map(revisionDTO);
  });
  app.post("/api/uploads", async (req) => beginUpload(await identity(req, SHELF), req.body));
  // «Сохранить как ссылку» (docs/specs/SAVED_LINKS.md).
  app.post("/api/links", { bodyLimit: 8192 }, async (req) => {
    const actor = await identity(req, SHELF);
    // Each save may fetch the page's title from the site it names.
    await limitAttempts(`save-link:${actor.id}`, 60);
    return saveLink(actor, req.body);
  });
  // The owner's «Открыть ↗» on a link work: the address is read from its file
  // and the browser is sent there, without a referrer.
  app.get("/api/revisions/:id/open", async (req, reply) => {
    const actor = await identity(req, SHELF);
    const {
      rows: [r],
    } = await db.query("SELECT * FROM revisions WHERE id=$1 AND tenant_id=$2", [id(req), actor.tenant]);
    if (!r || r.mime !== LINK_MIME) throw missing();
    const { url } = readLinkDocument(await readBlob(r.object_key, r.object_version));
    return reply.header("referrer-policy", "no-referrer").header("cache-control", "no-store").redirect(url, 303);
  });
  // Runs before the body is read. The session is checked first, so requests
  // without one never hold a slot, and one shelf cannot take all of them.
  let transfers = 0;
  const tenantTransfers = new Map<string, number>();
  const transferGuard = async (req: any, reply: any) => {
    // Per shelf and member: on a department shelf one member's transfers do
    // not take every slot of the shelf (on one's own shelf it is the same).
    const actor = await identity(req, SHELF);
    const tenant = `${actor.tenant}:${actor.id}`;
    const mine = tenantTransfers.get(tenant) ?? 0;
    if (transfers >= TRANSFER_SLOTS.total || mine >= TRANSFER_SLOTS.perTenant)
      throw new Problem(429, "quota", "Сервер принимает несколько файлов. Повторите через минуту.").retryIn(60);
    transfers++;
    tenantTransfers.set(tenant, mine + 1);
    reply.raw.once("close", () => {
      transfers--;
      const left = (tenantTransfers.get(tenant) ?? 1) - 1;
      if (left > 0) tenantTransfers.set(tenant, left);
      else tenantTransfers.delete(tenant);
    });
  };
  app.put("/api/uploads/:id/bytes", { onRequest: transferGuard }, async (req) => {
    if (!Buffer.isBuffer(req.body))
      throw new Problem(415, "invalid", "Файл должен передаваться отдельным двоичным запросом.");
    return uploadBytes(await identity(req, SHELF), id(req), req.body);
  });
  app.post("/api/uploads/:id/finalize", async (req) => finalizeUpload(await identity(req, SHELF), id(req)));
  app.get("/api/uploads/:id", async (req) => {
    return uploadStatus(await identity(req, SHELF), id(req), "single");
  });
  app.delete("/api/uploads/:id", async (req) => abortUpload(await identity(req, SHELF), id(req), "single"));
  app.post("/api/bundle-uploads", { bodyLimit: 64 * 1024 }, async (req) =>
    beginBundleUpload(await identity(req, SHELF), req.body),
  );
  app.put("/api/bundle-uploads/:id/files/:index", { onRequest: transferGuard }, async (req) => {
    if (!Buffer.isBuffer(req.body))
      throw new Problem(415, "invalid", "Файл пакета должен передаваться отдельным двоичным запросом.");
    const index = z.coerce
      .number()
      .int()
      .min(0)
      .max(63)
      .parse((req.params as any).index);
    return uploadBundleFile(await identity(req, SHELF), id(req), index, req.body);
  });
  app.post("/api/bundle-uploads/:id/finalize", async (req) =>
    finalizeBundleUpload(await identity(req, SHELF), id(req)),
  );
  app.get("/api/bundle-uploads/:id", async (req) => uploadStatus(await identity(req, SHELF), id(req), "bundle"));
  app.delete("/api/bundle-uploads/:id", async (req) => abortUpload(await identity(req, SHELF), id(req), "bundle"));
}
