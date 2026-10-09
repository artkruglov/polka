import { z } from "zod";
import { transaction, db } from "./db.ts";
import { lockShelf } from "./shelves.ts";

export const SHELF_CARD_MAX = 8000;
const cardSchema = z.object({ cardMd: z.string().max(SHELF_CARD_MAX).nullable() }).strict();

type Actor = { id: string; tenant: string };

/** The card of the actor's shelf; any member may read it. */
export async function readShelfCard(actor: Actor) {
  const {
    rows: [row],
  } = await db.query("SELECT card_md FROM tenants WHERE id=$1", [actor.tenant]);
  return { cardMd: (row?.card_md as string | null) ?? null };
}

/** A curator or admin of the shelf (its owner, on a personal one) writes it. */
export async function setShelfCard(actor: Actor, body: unknown) {
  const { cardMd } = cardSchema.parse(body);
  const text = cardMd?.trim() ? cardMd.trim() : null;
  return transaction(async (c) => {
    await lockShelf(c, actor, "curator");
    await c.query("UPDATE tenants SET card_md=$2 WHERE id=$1", [actor.tenant, text]);
    return { cardMd: text };
  });
}
