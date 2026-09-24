import { createHmac } from "node:crypto";
import { config } from "./config.ts";

// Product analytics keys (deploy/migrations/034_product_analytics.sql). A key
// of its own, derived from LINK_KEY for this purpose only: an actor key is
// never the account id, and without LINK_KEY it cannot be linked back to one.
let key: Buffer | null = null;
const analyticsKey = () =>
  (key ??= createHmac("sha256", config.LINK_KEY)
    .update("polka:analytics:v1")
    .digest());

/** The pseudonymous key analytics stores for an account (43 base64url chars). */
export const actorKey = (accountId: string) =>
  createHmac("sha256", analyticsKey())
    .update(`actor:${accountId}`)
    .digest("base64url");

/** The key of a share for the once-a-day share_opened count. */
export const shareKey = (shareId: string) =>
  createHmac("sha256", analyticsKey())
    .update(`share:${shareId}`)
    .digest("base64url");
