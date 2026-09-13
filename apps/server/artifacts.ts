import { randomUUID, createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import {
  beginUploadSchema,
  type Revision,
  type Share,
  type Artifact,
} from "../../packages/contracts/index.ts";
import { db, transaction } from "./db.ts";
import { config } from "./config.ts";
import { putImmutable, readBlob, sha256 } from "./storage.ts";
import { Problem, missing } from "./errors.ts";
export type Actor = { id: string; tenant: string };
export const audit = (
  c: PoolClient,
  actor: Actor,
  action: string,
  target: string,
) =>
  c.query(
    "INSERT INTO audit_outbox(tenant_id,actor_id,action,target_id) VALUES($1,$2,$3,$4)",
    [actor.tenant, actor.id, action, target],
  );
export const tokenFor = (id: string) =>
  createHmac("sha256", config.LINK_KEY)
    .update(`share:${id}`)
    .digest("base64url");
export const revisionDTO = (r: any): Revision => ({
  id: r.id,
  number: r.number,
  filename: r.filename,
  mime: r.mime,
  size: r.size,
  sha256: r.sha256,
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
    expiresAt: new Date(s.expires_at).toISOString(),
    url: ["active", "behind"].includes(status)
      ? `${config.APP_ORIGIN}/s#${tokenFor(s.id)}`
      : null,
  };
}
export async function getArtifact(actor: Actor, id: string): Promise<Artifact> {
  const {
    rows: [a],
  } = await db.query("SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2", [
    id,
    actor.tenant,
  ]);
  if (!a) throw missing();
  const {
    rows: [r],
  } = await db.query("SELECT * FROM revisions WHERE id=$1", [
    a.latest_revision_id,
  ]);
  const {
    rows: [s],
  } = await db.query(
    "SELECT s.*,r.number FROM shares s JOIN revisions r ON r.id=s.revision_id WHERE s.artifact_id=$1 ORDER BY s.created_at DESC,s.id DESC LIMIT 1",
    [id],
  );
  return {
    id: a.id,
    title: a.title,
    folderId: a.folder_id,
    updatedAt: a.updated_at.toISOString(),
    revision: revisionDTO(r),
    share: shareDTO(s, r.id),
  };
}
export async function beginUpload(actor: Actor, body: unknown) {
  const input = beginUploadSchema.parse(body);
  return transaction(async (c) => {
    const {
      rows: [tenant],
    } = await c.query("SELECT * FROM tenants WHERE id=$1 FOR UPDATE", [
      actor.tenant,
    ]);
    const {
      rows: [old],
    } = await c.query(
      "SELECT * FROM uploads WHERE tenant_id=$1 AND idempotency_key=$2",
      [actor.tenant, input.key],
    );
    if (old) {
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
        "SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2",
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
      "INSERT INTO uploads(id,tenant_id,account_id,idempotency_key,request) VALUES($1,$2,$3,$4,$5)",
      [id, actor.tenant, actor.id, input.key, input],
    );
    return { uploadId: id, receipt: null };
  });
}
function validateBytes(
  bytes: Buffer,
  input: ReturnType<typeof beginUploadSchema.parse>,
) {
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
  if (input.mime === "text/plain") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (bytes.includes(0)) throw new Error();
    } catch {
      throw new Problem(
        422,
        "invalid",
        "Для текста поддерживается кодировка UTF-8.",
      );
    }
  }
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
  return transaction(async (c) => {
    const u = await lockUpload(c, actor, id);
    const input = beginUploadSchema.parse(u.request);
    validateBytes(bytes, input);
    if (u.receipt) return { stored: true };
    const version = await putImmutable(`${actor.tenant}/${id}`, bytes);
    await c.query("UPDATE uploads SET object_version=$2 WHERE id=$1", [
      id,
      version,
    ]);
    return { stored: true };
  });
}
export async function finalizeUpload(actor: Actor, id: string) {
  return transaction(async (c) => {
    // All quota changes take the same tenant lock before upload/artifact locks.
    const {
      rows: [tenant],
    } = await c.query("SELECT * FROM tenants WHERE id=$1 FOR UPDATE", [
      actor.tenant,
    ]);
    const u = await lockUpload(c, actor, id);
    if (u.receipt) return u.receipt;
    if (!u.object_version)
      throw new Problem(409, "conflict", "Сначала дождитесь передачи файла.");
    const input = beginUploadSchema.parse(u.request);
    validateBytes(
      await readBlob(`${actor.tenant}/${id}`, u.object_version),
      input,
    );
    if (+tenant.used_bytes + input.size > +tenant.quota_bytes)
      throw new Problem(413, "quota", "Недостаточно места для этой версии.");
    if (
      !(
        await c.query("SELECT 1 FROM accounts WHERE id=$1 AND NOT disabled", [
          actor.id,
        ])
      ).rowCount
    )
      throw new Problem(403, "forbidden", "Доступ к аккаунту закрыт.");
    let artifactId = input.artifactId,
      number = 1;
    if (artifactId) {
      const {
        rows: [a],
      } = await c.query(
        "SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
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
        [
          artifactId,
          actor.tenant,
          actor.id,
          input.folderId ?? null,
          input.title,
        ],
      );
    }
    const revisionId = randomUUID();
    await c.query(
      "INSERT INTO revisions(id,tenant_id,artifact_id,number,created_by,filename,mime,size,sha256,object_key,object_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
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
      sha256: input.sha256,
    };
    await c.query("UPDATE uploads SET receipt=$2 WHERE id=$1", [id, receipt]);
    await audit(c, actor, "revision.saved", revisionId);
    return receipt;
  });
}
