import {
  ListObjectVersionsCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { db, transaction } from "../apps/server/db.ts";
import { bucket, s3 } from "../apps/server/storage.ts";
// Bounded, explicit cleanup. Tenant→upload lock order matches finalize.
// Receipted objects are never selected, even if their upload timeout passed.
try {
  const { rows } = await db.query(
    "SELECT id,tenant_id FROM uploads WHERE receipt IS NULL AND reconciled_at IS NULL AND (aborted OR expires_at<now()) ORDER BY expires_at LIMIT 100",
  );
  let cleaned = 0;
  for (const candidate of rows)
    await transaction(async (c) => {
      await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [
        candidate.tenant_id,
      ]);
      const {
        rows: [u],
      } = await c.query(
        "SELECT * FROM uploads WHERE id=$1 AND receipt IS NULL AND reconciled_at IS NULL AND (aborted OR expires_at<now()) FOR UPDATE",
        [candidate.id],
      );
      if (!u) return;
      const key = `${u.tenant_id}/${u.id}`;
      if (
        (await c.query("SELECT 1 FROM revisions WHERE object_key=$1", [key]))
          .rowCount
      )
        throw new Error("Receipt reconciliation required");
      const versions = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: key,
          MaxKeys: 100,
        }),
      );
      if (versions.IsTruncated)
        throw new Error(
          "Unexpected object history; manual reconciliation required",
        );
      for (const v of [
        ...(versions.Versions ?? []),
        ...(versions.DeleteMarkers ?? []),
      ])
        if (v.Key === key)
          await s3.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: key,
              VersionId: v.VersionId,
            }),
          );
      await c.query(
        "UPDATE uploads SET aborted=true,object_version=NULL,reconciled_at=now() WHERE id=$1",
        [u.id],
      );
      // Keep the idempotency tombstone; do not make an expired key reusable.
      cleaned++;
    });
  await db.query("DELETE FROM grants WHERE expires_at<now()");
  await db.query("DELETE FROM sessions WHERE expires_at<now()");
  await db.query("DELETE FROM login_limits WHERE reset_at<now()");
  console.log(JSON.stringify({ expiredUploadsReconciled: cleaned }));
} finally {
  await db.end();
  s3.destroy();
}
