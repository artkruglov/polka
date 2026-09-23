import { z } from "zod";
import { AGENT_SCOPES, MAX_BYTES } from "../../packages/contracts/index.ts";
import { agentPublishInputSchema } from "./agent-publish.ts";
import { agentGetArtifactInputSchema } from "./agent-management.ts";
import { POLKA_VERSION } from "./mcp-server.ts";
import {
  PUBLISH_API_LIMITS,
  PUBLISH_BODY_LIMIT,
  problemSchema,
  publishResponseSchema,
  statusResponseSchema,
} from "./publish-api.ts";

/**
 * GET /openapi.json: the agent HTTP API (apps/server/publish-api.ts) as
 * OpenAPI 3.1. Every schema comes from the zod schemas the routes parse and
 * the response schemas the tests hold the routes to; only prose is written
 * here. tests/agent-discovery.test.ts checks that every route the module
 * registers is described.
 */

/** JSON Schema 2020-12 (the OpenAPI 3.1 dialect) without its $schema line. */
function jsonSchema(schema: z.ZodType, io: "input" | "output") {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io });
  return rest as Record<string, any>;
}

/** Prose for request fields; the test fails if a name is not a real field. */
export const PUBLISH_FIELD_NOTES: Record<string, string> = {
  key: "Idempotency key: a fresh UUID per artifact. Reuse it only to retry the same request; the retry returns the same work and the same link. The same key with a different body is 409.",
  title: "Title on the owner's shelf.",
  html: `One self-contained HTML document, at most ${MAX_BYTES / 1024 / 1024} MB in UTF-8: CSS in <style>, images and fonts as data: URIs, no external URLs (the viewer has no network). Send exactly one of html and component.`,
  component:
    "React component source as-is (default export rendered full-page). Only where the installation runs scripts; otherwise 422 unsupported.",
  componentLanguage: "Only with component. Default jsx.",
  folderId: "Optional folder on the shelf.",
  expiresInDays:
    "Link lifetime. A new account gets at most 7 days: 30 becomes 7 and expiresNote says so.",
};

export const PUBLISH_RESPONSE_NOTES: Record<string, string> = {
  state:
    "shared: url is a live link. saved: the work is saved privately and url is null; linkUnavailableReason says why.",
  url: "The unlisted link (…/s#…) to give the human. Anyone with it can open the work until it expires or is revoked.",
  shelfUrl:
    "The work on the owner's shelf. Opens only for the signed-in owner; not a share link.",
  moderation:
    "Present only while the link waits for a Полка moderator: recipients see a review screen until approval. Relay moderationMessage to the human; do not present the link as ready.",
  expiresNote:
    "The link was issued for fewer days than requested (new account).",
};

function withNotes(schema: Record<string, any>, notes: Record<string, string>) {
  for (const [name, description] of Object.entries(notes))
    schema.properties[name] = { description, ...schema.properties[name] };
  return schema;
}

const problem = (
  description: string,
  examples: Record<string, { code: string; message: string }>,
) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Problem" },
      examples: Object.fromEntries(
        Object.entries(examples).map(([name, value]) => [name, { value }]),
      ),
    },
  },
});

const common = {
  "401": {
    ...problem(
      "No Authorization header, or the token is wrong, expired or revoked. The WWW-Authenticate header says Bearer.",
      {
        missing: {
          code: "unauthorized",
          message: "Нужен заголовок Authorization: Bearer <токен агента>.",
        },
      },
    ),
    headers: {
      "WWW-Authenticate": {
        schema: { type: "string" },
        example: 'Bearer realm="polka", error="invalid_token"',
      },
    },
  },
  "403": problem(
    "The token lacks the scope, or the request came from a browser page on another origin.",
    {
      scope: {
        code: "forbidden",
        message: "У подключения нет разрешения для этого действия.",
      },
    },
  ),
  "429": problem(
    `Rate limit: ${PUBLISH_API_LIMITS.perConnection} requests per token and ${PUBLISH_API_LIMITS.perIp} per IP address in 10 minutes. Retry later with the same key.`,
    {
      rate: {
        code: "quota",
        message: "Слишком много попыток. Попробуйте через 10 минут.",
      },
    },
  ),
  "503": problem(
    "The request collided with another action on the same works; nothing was committed. Retry with the same key after Retry-After.",
    {
      busy: {
        code: "busy",
        message:
          "Полка сейчас занята другим действием с этими работами. Повторите через несколько секунд.",
      },
    },
  ),
};

export function openApiDocument(origin: string) {
  const artifactId = jsonSchema(agentGetArtifactInputSchema, "input").properties
    .artifactId;
  return {
    openapi: "3.1.0",
    info: {
      title: "Полка agent HTTP API",
      version: POLKA_VERSION,
      summary:
        "Save a self-contained HTML page to the token owner's Полка shelf and get an unlisted link.",
      description: `Полка (Polka) keeps pages, reports and prototypes made with AI agents and gives an unlisted link to them. This API is for agents and scripts that do not speak MCP; MCP clients connect to ${origin}/mcp instead (see ${origin}/llms.txt). The human creates the token in the browser; never ask them to paste it into a chat. Errors are JSON {code, message}; message is Russian and meant for the human.`,
      license: {
        name: "Apache-2.0",
        identifier: "Apache-2.0",
      },
    },
    externalDocs: {
      description: "Agent guide (plain text)",
      url: `${origin}/llms.txt`,
    },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/publish": {
        post: {
          operationId: "publish",
          summary: "Save one HTML page and get a link",
          description:
            "Saves the page privately on the token owner's shelf and, when the token has the share scope, returns an unlisted link in the same call. Requires capture. Retry network errors, 429 and 5xx with the same key.",
          security: [{ bearerAuth: ["capture"] }],
          requestBody: {
            required: true,
            description: `JSON body, at most ${PUBLISH_BODY_LIMIT / 1024 / 1024} MB.`,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublishRequest" },
                examples: {
                  html: {
                    summary: "A static report with a 7-day link",
                    value: {
                      key: "0b5f3a4e-3c2d-4f7a-9f55-6d1f0c9e8a21",
                      title: "Quarterly report",
                      html: '<!doctype html><html><head><meta charset="utf-8"><title>Quarterly report</title><style>body{font-family:system-ui;margin:40px}</style></head><body><h1>Quarterly report</h1></body></html>',
                      expiresInDays: 7,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Saved. state tells whether a link was issued; check moderation before presenting the link.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublishResponse" },
                  examples: {
                    shared: {
                      value: {
                        artifactId: "5d0c7a61-8a52-4b7e-9d0e-2f7b1b7f4c11",
                        revisionId: "9a1e3f0b-6c1d-4e0a-8f4b-3b9d2e7c5a10",
                        state: "shared",
                        url: `${origin}/s#Q2x1ZS1zaGFyZS10b2tlbi1leGFtcGxlLW5vdC1yZWFs`,
                        expiresAt: "2026-09-30T12:00:00.000Z",
                        shelfUrl: `${origin}/works/5d0c7a61-8a52-4b7e-9d0e-2f7b1b7f4c11`,
                        interactiveReady: false,
                        scriptsRunForRecipients: false,
                      },
                    },
                    held: {
                      summary: "The link waits for a moderator",
                      value: {
                        artifactId: "5d0c7a61-8a52-4b7e-9d0e-2f7b1b7f4c11",
                        revisionId: "9a1e3f0b-6c1d-4e0a-8f4b-3b9d2e7c5a10",
                        state: "shared",
                        url: `${origin}/s#Q2x1ZS1zaGFyZS10b2tlbi1leGFtcGxlLW5vdC1yZWFs`,
                        expiresAt: "2026-09-30T12:00:00.000Z",
                        shelfUrl: `${origin}/works/5d0c7a61-8a52-4b7e-9d0e-2f7b1b7f4c11`,
                        interactiveReady: false,
                        scriptsRunForRecipients: false,
                        moderation: "held",
                        moderationMessage:
                          "Ссылка создана, но пока на проверке у модератора Полки: получатели увидят работу после одобрения.",
                        expiresNote:
                          "Ссылка выдана на 7 дней вместо 30: новым аккаунтам Полки ссылки выдаются не дольше чем на 7 дней.",
                      },
                    },
                    saved: {
                      summary: "Saved privately: the token has no share scope",
                      value: {
                        artifactId: "5d0c7a61-8a52-4b7e-9d0e-2f7b1b7f4c11",
                        revisionId: "9a1e3f0b-6c1d-4e0a-8f4b-3b9d2e7c5a10",
                        state: "saved",
                        url: null,
                        expiresAt: null,
                        shelfUrl: `${origin}/works/5d0c7a61-8a52-4b7e-9d0e-2f7b1b7f4c11`,
                        interactiveReady: false,
                        scriptsRunForRecipients: false,
                        linkUnavailableReason:
                          "Saved privately. This connection was not granted the link permission (Управлять ссылками); the owner can share it from the shelf or reconnect with that permission.",
                      },
                    },
                  },
                },
              },
            },
            "400": problem(
              "Fields failed validation (the message names them), invalid UTF-8, or html longer than 7,000,000 characters.",
              {
                fields: {
                  code: "invalid",
                  message: "Проверьте поля запроса: key, title.",
                },
              },
            ),
            "401": common["401"],
            "403": common["403"],
            "409": problem(
              "The same key was already used for different content.",
              {
                key: {
                  code: "conflict",
                  message: "Ключ уже относится к другой операции.",
                },
              },
            ),
            "413": problem(
              `The page is larger than ${MAX_BYTES / 1024 / 1024} MB, the body larger than ${PUBLISH_BODY_LIMIT / 1024 / 1024} MB, or the shelf is out of space.`,
              {
                size: {
                  code: "quota",
                  message:
                    "Страница больше 5 МБ. Уменьшите её: уберите встроенные шрифты и крупные картинки.",
                },
              },
            ),
            "422": problem(
              "Not HTML, contains NUL, or component was sent where the installation does not run scripts.",
              {
                component: {
                  code: "unsupported",
                  message:
                    "Здесь скрипты не запускаются: пришлите статичный HTML-снимок того, что показывает компонент, в поле html.",
                },
              },
            ),
            "429": common["429"],
            "503": common["503"],
          },
        },
      },
      "/api/v1/status/{artifactId}": {
        get: {
          operationId: "status",
          summary: "Metadata of one saved work",
          description:
            "Title, folder, latest revision, HTML profile, interactive build state and trash state, with shelfUrl. No bytes and no share links. A token without the read scope sees only works saved through its own connection.",
          security: [{ bearerAuth: ["context"] }],
          parameters: [
            {
              name: "artifactId",
              in: "path",
              required: true,
              schema: artifactId,
              example: "5d0c7a61-8a52-4b7e-9d0e-2f7b1b7f4c11",
            },
          ],
          responses: {
            "200": {
              description: "The work.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/StatusResponse" },
                },
              },
            },
            "400": problem("artifactId is not a UUID.", {
              id: {
                code: "invalid",
                message: "Проверьте поля запроса: artifactId.",
              },
            }),
            "401": common["401"],
            "403": common["403"],
            "404": problem(
              "No such work, or it is not visible to this token.",
              {
                missing: {
                  code: "not_found",
                  message:
                    "Материал недоступен. Ссылка могла измениться или доступ был закрыт.",
                },
              },
            ),
            "429": common["429"],
            "503": common["503"],
          },
        },
      },
      "/api/v1/cli/polka-publish.mjs": {
        get: {
          operationId: "downloadCli",
          summary: "Download the dependency-free CLI",
          description:
            "A single-file Node 22+ script that calls POST /api/v1/publish on this installation. It reads the token only from POLKA_TOKEN.",
          security: [],
          responses: {
            "200": {
              description: "The script, pointed at this installation.",
              content: {
                "text/javascript": { schema: { type: "string" } },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: `An agent token of the shelf owner: created by the human at ${origin}/settings/agents (client «HTTP API / скрипт», shown once), or the OAuth access token of an MCP connection (audience ${origin}/mcp). Send it only in this header; keep it in an environment variable, never in a chat, command line or log. Scopes: ${AGENT_SCOPES.join(", ")}. publish needs capture; the link needs share.`,
        },
      },
      schemas: {
        PublishRequest: {
          ...withNotes(
            jsonSchema(agentPublishInputSchema, "input"),
            PUBLISH_FIELD_NOTES,
          ),
          description: "Send exactly one of html and component.",
        },
        PublishResponse: withNotes(
          jsonSchema(publishResponseSchema, "output"),
          PUBLISH_RESPONSE_NOTES,
        ),
        StatusResponse: jsonSchema(statusResponseSchema, "output"),
        Problem: jsonSchema(problemSchema, "output"),
      },
    },
  };
}
