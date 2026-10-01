import { z } from "zod";
import { transaction } from "./db.ts";
import { missing } from "./errors.ts";
import { audit } from "./artifacts.ts";
import { lockShelf } from "./shelves.ts";

type Actor = { id: string; tenant: string };

const input = z.object({ followMode: z.enum(["pinned", "follows"]) }).strict();

/**
 * A curator lets an unattended agent move this link to the work's new
 * versions ("follows") or holds it on its version ("pinned", the default).
 * A person's own publish moves the link either way (agent-publish.ts).
 */
export async function setShareFollowMode(actor: Actor, shareId: string, body: unknown) {
  const { followMode } = input.parse(body);
  return transaction(async (c) => {
    await lockShelf(c, actor, "curator");
    const {
      rows: [share],
    } = await c.query(
      `SELECT id,artifact_id,follow_mode FROM shares
       WHERE id=$1 AND tenant_id=$2 AND NOT revoked FOR UPDATE`,
      [shareId, actor.tenant],
    );
    if (!share) throw missing();
    if (share.follow_mode !== followMode) {
      await c.query("UPDATE shares SET follow_mode=$2 WHERE id=$1", [shareId, followMode]);
      await audit(c, actor, "share.follow_mode_changed", shareId, {
        artifactId: share.artifact_id,
        followMode,
      });
    }
    return { shareId, followMode };
  });
}
