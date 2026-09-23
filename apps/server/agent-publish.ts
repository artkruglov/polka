import { createHash } from "node:crypto";
import { z } from "zod";
import {
  MAX_BYTES,
  uuid,
  type InlineBuildStatus,
} from "../../packages/contracts/index.ts";
import {
  RUNTIME_IMPORT_LIST,
  componentShell,
} from "../../packages/contracts/runtime.ts";
import { captureFromAgent } from "./agent-capture.ts";
import {
  preparePreviewFromAgent,
  previewStatusInTransaction,
} from "./agent-preview.ts";
import { DERIVATIVE_BUILD_TIMEOUT_MS } from "./bundle-runtime-contract.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { Problem } from "./errors.ts";
import {
  recheckServiceActor,
  withServiceActorTransaction,
  type ServiceActor,
} from "./service-auth.ts";
import { shareFromAgent } from "./shares.ts";
import { NEW_ACCOUNT_MAX_DAYS, authorStanding } from "./share-moderation.ts";

const MAX_HTML_MB = Math.floor(MAX_BYTES / (1024 * 1024));

export const agentPublishInputSchema = z
  .object({
    key: uuid,
    title: z.string().trim().min(1).max(160),
    html: z.string().min(1).max(7_000_000).optional(),
    component: z.string().min(1).max(7_000_000).optional(),
    componentLanguage: z.enum(["jsx", "tsx"]).optional(),
    folderId: uuid.optional(),
    expiresInDays: z
      .union([z.literal(1), z.literal(7), z.literal(30)])
      .default(30),
  })
  .strict()
  .refine(
    (value) => (value.html === undefined) !== (value.component === undefined),
    {
      message: "Send exactly one of html or component",
    },
  )
  .refine(
    (value) => !value.componentLanguage || value.component !== undefined,
    {
      message: "componentLanguage goes with component",
    },
  );

/**
 * What the chat tool description tells the model about this installation.
 * Where the interactive viewer is enabled, scripts are kept and run; the
 * guidance names what the interactive builder accepts (bundle-inline and
 * the Полка runtime for component source).
 */
export function publishToolDescription(
  liveEnabled: boolean = config.HTML_LIVE_ENABLED,
) {
  return [
    'Save one chat artifact to the owner\'s Polka shelf and, when this connection may manage links, return an unlisted share link in the same call. Use it when the user asks to save/publish an artifact to Polka ("сохрани на Полку").',
    ...(liveEnabled
      ? [
          `Send the artifact either as React component source in \`component\` (below) or as ONE self-contained HTML document in \`html\`. Scripts run in an isolated sandbox on a separate viewer domain, and the returned link opens the interactive version. The sandbox has no network: no external URLs (no remote stylesheets, fonts or images, no fetch); eval/new Function and workers are unavailable. Keep it under ${MAX_HTML_MB} MB.`,
          `A React artifact (JSX/TSX component, as written in the chat): send its source code as-is in \`component\` instead of \`html\` (componentLanguage "tsx" for TypeScript) — do not bundle it or write an HTML shell. Polka compiles it on the server: the default export is rendered full-page, Tailwind classes work (CSS is generated for the classes used), and these imports are available offline: ${RUNTIME_IMPORT_LIST}. Any other import (framer-motion, shadcn/ui "@/components/...", URLs) fails and the reason names the module; replace it with plain React/Tailwind. localStorage/sessionStorage and window.storage work in memory for the open page; fetch and other network calls fail.`,
          'For `html`, the interactive builder accepts: CSS in <style> or style attributes; images as <img> or CSS url() with base64 data: URIs (png, jpeg, webp, gif, plain SVG); fonts as base64 data: woff2/woff or system fonts; inline <svg> (<use href="#id">); links to #fragments or absolute https/mailto addresses; <script type=module> or text/babel importing only the libraries above; CDN <script src> of those libraries, Babel and the Tailwind CDN are replaced by Polka\'s own copies. It refuses other relative or remote resource URLs, <iframe> and <video>/<audio>. Markdown or text: convert to semantic HTML first.',
        ]
      : [
          `Send the artifact as ONE standalone HTML document in \`html\`: all CSS inline in <style>, images as data: URIs, fonts as data: URIs or system fonts. No external URLs at all: no CDN scripts or stylesheets, no remote images, no forms. The viewer has no network. Keep it under ${MAX_HTML_MB} MB.`,
          "Recipients see the page in a static sandbox where scripts do not run. For a React/JSX or other scripted artifact, send a static HTML snapshot of what it renders (the resulting markup and styles), not the source code or an app shell. Markdown or text: convert to semantic HTML first.",
        ]),
    "key: a fresh UUID per artifact; reuse it only to retry the same call. title: short human title. expiresInDays: 1, 7 or 30 (default 30; a new Polka account gets at most 7, and `expiresNote` says so).",
    'If `moderation` is "held" (or "paused"), the link exists but recipients see a "being reviewed by a Polka moderator" screen until the moderator approves it: tell the user exactly that (relay `moderationMessage`) and do not present the link as ready.',
    liveEnabled
      ? "Report the returned `url` to the user as the link. If `url` is null, tell the user the work is saved privately (shelfUrl) and relay `linkUnavailableReason`. If `interactiveUnavailableReason` is present, tell the user the scripts will not run and why; the link, if any, shows a static copy."
      : "Report the returned `url` to the user as the link. If `url` is null, tell the user the work is saved privately (shelfUrl) and relay `linkUnavailableReason`.",
  ].join("\n");
}

type InteractiveOutcome = { ready: boolean; reason: string | null };

/**
 * Builds the interactive version of a scripted page in the same call, so the
 * link is bound to it. Build refusals are reported, never thrown: the save
 * and a static link stand on their own.
 */
async function prepareInteractive(
  actor: ServiceActor,
  key: string,
  revisionId: string,
  htmlProfile: string | null,
): Promise<InteractiveOutcome | null> {
  if (!config.HTML_LIVE_ENABLED || htmlProfile === "static") return null;
  let status: InlineBuildStatus | null;
  try {
    status = await preparePreviewFromAgent(actor, { key });
    // Another call with this key may be building; wait for it within the
    // builder's own deadline instead of starting a second build.
    const deadline = Date.now() + DERIVATIVE_BUILD_TIMEOUT_MS + 1_000;
    while (status?.state === "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await withServiceActorTransaction(actor, "capture", (c) =>
        previewStatusInTransaction(c, actor.tenantId, revisionId),
      );
    }
  } catch (error) {
    if (error instanceof Problem)
      return { ready: false, reason: error.message };
    throw error;
  }
  if (status?.state === "ready") return { ready: true, reason: null };
  return {
    ready: false,
    reason:
      status?.state === "pending"
        ? "Интерактивная версия ещё собирается; владелец увидит её на Полке, когда сборка закончится."
        : `Интерактивную версию не удалось собрать: ${status?.reason ?? "причина не указана"}${status?.path ? ` (${status.path})` : ""}.`,
  };
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

/**
 * The saved files: the HTML as sent, or a component's source kept verbatim
 * next to the Полка shell that the runtime builder compiles.
 */
function publishedFiles(input: z.infer<typeof agentPublishInputSchema>) {
  if (input.html !== undefined)
    return [{ path: "index.html", mime: "text/html", data: input.html }];
  if (!config.HTML_LIVE_ENABLED)
    throw new Problem(
      422,
      "unsupported",
      "Здесь скрипты не запускаются: пришлите статичный HTML-снимок того, что показывает компонент, в поле html.",
    );
  const file = input.componentLanguage === "tsx" ? "App.tsx" : "App.jsx";
  return [
    {
      path: "index.html",
      mime: "text/html",
      data: componentShell(input.title, file),
    },
    { path: file, mime: "text/javascript", data: input.component! },
  ];
}

/**
 * A new account's link lasts at most 7 days. polka_publish defaults to 30, so
 * instead of refusing the first link of every new user it is issued for 7 and
 * the answer says so. A retry keeps the length its first call stored.
 */
async function publishExpiry(
  actor: ServiceActor,
  key: string,
  requested: number,
) {
  if (requested <= NEW_ACCOUNT_MAX_DAYS) return { days: requested };
  const {
    rows: [prior],
  } = await db.query(
    `SELECT request->>'expiresInDays' AS days FROM agent_operations
     WHERE tenant_id=$1 AND operation='share' AND idempotency_key=$2`,
    [actor.tenantId, key],
  );
  if (prior?.days) return { days: Number(prior.days) };
  const standing = await authorStanding(db, actor.tenantId);
  return { days: standing.trusted ? requested : NEW_ACCOUNT_MAX_DAYS };
}

export async function publishFromAgent(actor: ServiceActor, raw: unknown) {
  const input = agentPublishInputSchema.parse(raw);
  const files = publishedFiles(input).map((file) => ({
    ...file,
    bytes: Buffer.from(file.data, "utf8"),
  }));
  if (files.reduce((total, file) => total + file.bytes.length, 0) > MAX_BYTES)
    throw new Problem(
      413,
      "quota",
      `Страница больше ${MAX_HTML_MB} МБ. Уменьшите её: уберите встроенные шрифты и крупные картинки.`,
    );
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
        files: files.map((file) => ({
          path: file.path,
          mime: file.mime,
          size: file.bytes.length,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
        })),
        provenance: {
          kind: "mcp",
          sourceUrl: null,
          capturedAt: await capturedAtFor(verified, input.key),
          attribution: "Created in a chat for the account owner",
          license: "unknown",
        },
        dependencies: { status: "self-contained", unresolved: [] },
      },
      files: files.map((file) => ({
        path: file.path,
        encoding: "utf8" as const,
        data: file.data,
      })),
    },
    "capture",
  )) as { artifactId: string; revisionId: string; htmlProfile?: string };
  const interactive = await prepareInteractive(
    verified,
    input.key,
    receipt.revisionId,
    receipt.htmlProfile ?? null,
  );
  const saved = {
    artifactId: receipt.artifactId,
    revisionId: receipt.revisionId,
    htmlProfile: receipt.htmlProfile ?? null,
    shelfUrl: `${config.APP_ORIGIN}/works/${receipt.artifactId}`,
    scriptsRunForRecipients: false,
    ...(interactive
      ? {
          interactiveReady: interactive.ready,
          ...(interactive.reason
            ? { interactiveUnavailableReason: interactive.reason }
            : {}),
        }
      : {}),
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
    const expiry = await publishExpiry(current, input.key, input.expiresInDays);
    // The same idempotency key names the share operation, so a retry returns
    // the same link instead of issuing another.
    const share = await shareFromAgent(current, {
      key: input.key,
      artifactId: receipt.artifactId,
      expectedRevisionId: receipt.revisionId,
      expiresInDays: expiry.days,
    });
    return {
      ...saved,
      state: share.url ? ("shared" as const) : ("saved" as const),
      url: share.url,
      shareId: share.shareId,
      expiresAt: share.expiresAt,
      scriptsRunForRecipients:
        share.url !== null && share.derivativeId !== null,
      ...("moderation" in share
        ? {
            moderation: share.moderation,
            moderationMessage: share.moderationMessage,
          }
        : {}),
      ...(share.url && expiry.days < input.expiresInDays
        ? {
            expiresNote: `Ссылка выдана на ${expiry.days} дней вместо ${input.expiresInDays}: новым аккаунтам Полки ссылки выдаются не дольше чем на ${NEW_ACCOUNT_MAX_DAYS} дней.`,
          }
        : {}),
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
      (error.code === "unsupported" ||
        error.code === "conflict" ||
        error.code === "quota")
    )
      return {
        ...saved,
        state: "saved" as const,
        url: null,
        // The generic refusal suggests polka_prepare_preview, which this call
        // already ran; the build's own reason is the useful one.
        linkUnavailableReason:
          error.code === "unsupported" && interactive?.reason
            ? `Ссылку не выпускаем: страницу нельзя показать без скриптов. ${interactive.reason}`
            : error.message,
      };
    throw error;
  }
}
