import { createHash } from "node:crypto";
import { z } from "zod";
import { uuid } from "../../packages/contracts/index.ts";
import { captureFromAgent } from "./agent-capture.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { Problem } from "./errors.ts";
import { recheckServiceActor, type ServiceActor } from "./service-auth.ts";
import { shareFromAgent } from "./shares.ts";

const MAX_HTML_BYTES = 8 * 1024 * 1024;

export const agentPublishInputSchema = z
  .object({
    key: uuid,
    title: z.string().trim().min(1).max(160),
    html: z.string().min(1).max(7_000_000),
    folderId: uuid.optional(),
    expiresInDays: z
      .union([z.literal(1), z.literal(7), z.literal(30)])
      .default(30),
  })
  .strict();

/** What the chat tool description tells the model about this installation. */
export function publishToolDescription() {
  return [
    'Save one chat artifact to the owner\'s Polka shelf and, when this connection may manage links, return an unlisted share link in the same call. Use it when the user asks to save/publish an artifact to Polka ("сохрани на Полку").',
    "Send the artifact as ONE standalone HTML document in `html`: all CSS inline in <style>, images as data: URIs, fonts as data: URIs or system fonts. No external URLs at all: no CDN scripts or stylesheets, no remote images, no forms. The viewer has no network.",
    "Recipients see the page in a static sandbox where scripts do not run. For a React/JSX or other scripted artifact, send a static HTML snapshot of what it renders (the resulting markup and styles), not the source code or an app shell. Markdown or text: convert to semantic HTML first.",
    "key: a fresh UUID per artifact; reuse it only to retry the same call. title: short human title. expiresInDays: 1, 7 or 30 (default 30).",
    "Report the returned `url` to the user as the link. If `url` is null, tell the user the work is saved privately (shelfUrl) and relay `linkUnavailableReason`.",
  ].join("\n");
}

/** A replay must rebuild the same upload request, including capture time. */
async function capturedAtFor(actor: ServiceActor, key: string) {
  const {
    rows: [prior],
  } = await db.query(
    `SELECT request->'manifest'->'provenance'->>'capturedAt' AS captured_at
     FROM uploads WHERE tenant_id=$1 AND idempotency_key=$2
       AND connection_id=$3`,
    [actor.tenantId, key, actor.connectionId],
  );
  return (
    (prior?.captured_at as string | undefined) ??
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  );
}

export async function publishFromAgent(actor: ServiceActor, raw: unknown) {
  const input = agentPublishInputSchema.parse(raw);
  const bytes = Buffer.from(input.html, "utf8");
  if (bytes.length > MAX_HTML_BYTES)
    throw new Problem(413, "quota", "Страница превышает лимит передачи 8 МБ.");
  const verified = await recheckServiceActor(actor, "capture");
  const receipt = (await captureFromAgent(
    verified,
    {
      key: input.key,
      title: input.title,
      ...(input.folderId ? { folderId: input.folderId } : {}),
      manifest: {
        version: 1,
        entrypoint: "index.html",
        runtime: "static-sandbox-v1",
        files: [
          {
            path: "index.html",
            mime: "text/html",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
        provenance: {
          kind: "mcp",
          sourceUrl: null,
          capturedAt: await capturedAtFor(verified, input.key),
          attribution: "Created in a chat for the account owner",
          license: "unknown",
        },
        dependencies: { status: "self-contained", unresolved: [] },
      },
      files: [{ path: "index.html", encoding: "utf8", data: input.html }],
    },
    "capture",
  )) as { artifactId: string; revisionId: string; htmlProfile?: string };
  const saved = {
    artifactId: receipt.artifactId,
    revisionId: receipt.revisionId,
    htmlProfile: receipt.htmlProfile ?? null,
    shelfUrl: `${config.APP_ORIGIN}/works/${receipt.artifactId}`,
    scriptsRunForRecipients: false,
  };
  const current = await recheckServiceActor(verified, "context");
  if (!current.scopes.includes("share"))
    return {
      ...saved,
      state: "saved" as const,
      url: null,
      linkUnavailableReason:
        "Saved privately. This connection was not granted the link permission (Управлять ссылками); the owner can share it from the shelf or reconnect with that permission.",
    };
  try {
    // The same idempotency key names the share operation, so a retry returns
    // the same link instead of issuing another.
    const share = await shareFromAgent(current, {
      key: input.key,
      artifactId: receipt.artifactId,
      expectedRevisionId: receipt.revisionId,
      expiresInDays: input.expiresInDays,
    });
    return {
      ...saved,
      state: share.url ? ("shared" as const) : ("saved" as const),
      url: share.url,
      shareId: share.shareId,
      expiresAt: share.expiresAt,
      scriptsRunForRecipients:
        share.url !== null && share.derivativeId !== null,
      ...(share.url
        ? {}
        : {
            linkUnavailableReason:
              "The link from this call was revoked or expired; it is not reissued automatically.",
          }),
    };
  } catch (error) {
    if (
      error instanceof Problem &&
      (error.code === "unsupported" || error.code === "conflict")
    )
      return {
        ...saved,
        state: "saved" as const,
        url: null,
        linkUnavailableReason: error.message,
      };
    throw error;
  }
}
