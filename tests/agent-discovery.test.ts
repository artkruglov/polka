import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { z } from "zod";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AGENT_SCOPES } from "../packages/contracts/index.ts";
import {
  HOSTED_ORIGIN,
  SKILL_NAME,
  agentSkillsIndex,
  llmsText,
  mcpToolCatalog,
  skillMarkdown,
} from "../apps/server/agent-discovery.ts";
import { agentPublishInputSchema } from "../apps/server/agent-publish.ts";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { connectGuide } from "../apps/server/connect-guide.ts";
import { db } from "../apps/server/db.ts";
import { createMcpServer } from "../apps/server/mcp-server.ts";
import {
  PUBLISH_FIELD_NOTES,
  PUBLISH_RESPONSE_NOTES,
  openApiDocument,
} from "../apps/server/openapi.ts";
import {
  problemSchema,
  publishResponseSchema,
  registerPublishApi,
} from "../apps/server/publish-api.ts";
import { MCP_AUDIENCE } from "../apps/server/service-auth.ts";
import { s3 } from "../apps/server/storage.ts";

const app = await createApp();
const origin = config.APP_ORIGIN;
const OTHER = "https://shelf.example.org";

after(async () => {
  await app.close();
  await db.end();
  s3.destroy();
});

const get = (url: string) => app.inject({ method: "GET", url });

function assertPublic(response: Awaited<ReturnType<typeof get>>, type: string) {
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], type);
  assert.equal(response.headers["cache-control"], "public, max-age=300");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.cookies.length, 0);
}

/** Every absolute URL in the text belongs to the given origin. */
function onlyOrigin(text: string, expected: string) {
  const urls = text.match(/https?:\/\/[^\s"'`)<>,;]+/g) ?? [];
  assert.ok(urls.length > 0);
  for (const url of urls)
    if (!url.startsWith("https://schemas.agentskills.io/"))
      assert.ok(url.startsWith(expected), `${url} is not on ${expected}`);
}

test("GET /llms.txt: plain text with every section, on APP_ORIGIN", async () => {
  const response = await get("/llms.txt");
  assertPublic(response, "text/plain; charset=utf-8");
  const text = response.body;
  for (const heading of [
    "# Полка (Polka)",
    "## Connect",
    "## MCP tools",
    "## HTTP API (without MCP)",
    "## Limits",
    "## Presenting the result",
  ])
    assert.ok(
      text.includes(`\n${heading}`) || text.startsWith(heading),
      heading,
    );
  assert.ok(text.includes(`${origin}/connect`));
  assert.ok(text.includes(`codex mcp add polka --url ${origin}/mcp`));
  assert.ok(text.includes(`${origin}/openapi.json`));
  assert.ok(text.includes(`curl -sS ${origin}/api/v1/publish`));
  assert.match(text, /5 MB/);
  assert.match(text, /1, 7 or 30 days/);
  assert.match(text, /`moderation`: "held"/);
  assert.match(text, /signs in or creates a shelf in their own browser/);
  assert.match(text, /Never print tokens/);
  onlyOrigin(text, origin);
  // The tools are the ones the MCP server registers, with their scopes.
  for (const tool of mcpToolCatalog())
    assert.ok(
      text.includes(`- ${tool.name} [${tool.scopes.join(" or ")}]: `),
      tool.name,
    );
  assert.ok(text.includes("- polka_publish [capture]: Save one chat artifact"));
});

test("the tool list in llms.txt is what tools/list returns for each scope", async () => {
  const catalog = mcpToolCatalog();
  assert.ok(catalog.length >= 10);
  for (const scope of AGENT_SCOPES) {
    const server = createMcpServer({
      accountId: "00000000-0000-0000-0000-000000000000",
      tenantId: "00000000-0000-0000-0000-000000000000",
      connectionId: "00000000-0000-0000-0000-000000000000",
      scopes: [scope],
      audience: MCP_AUDIENCE,
      expiresAt: 0,
    });
    const client = new Client({ name: "llms-txt", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name).sort();
      const documented = catalog
        .filter((tool) => tool.scopes.includes(scope))
        .map((tool) => tool.name)
        .sort();
      assert.deepEqual(listed, documented, scope);
    } finally {
      await client.close();
    }
  }
});

test("GET /openapi.json: OpenAPI 3.1 from the route schemas", async () => {
  const response = await get("/openapi.json");
  assertPublic(response, "application/json; charset=utf-8");
  const spec = JSON.parse(response.body);
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(spec.servers, [{ url: origin }]);
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.deepEqual(spec.paths["/api/v1/publish"].post.security, [
    { bearerAuth: ["capture"] },
  ]);
  // Every $ref resolves.
  const refs = response.body.match(/"\$ref":"[^"]+"/g) ?? [];
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const name = ref.slice(8, -1).replace("#/components/schemas/", "");
    assert.ok(spec.components.schemas[name], ref);
  }
  // The request schema is the one the route parses, field for field.
  const request = spec.components.schemas.PublishRequest;
  assert.deepEqual(
    Object.keys(request.properties).sort(),
    Object.keys(agentPublishInputSchema.shape).sort(),
  );
  assert.deepEqual(request.required, ["key", "title"]);
  assert.equal(request.additionalProperties, false);
  for (const name of Object.keys(PUBLISH_FIELD_NOTES))
    assert.ok(request.properties[name], `note for unknown field ${name}`);
  for (const name of Object.keys(PUBLISH_RESPONSE_NOTES))
    assert.ok(
      spec.components.schemas.PublishResponse.properties[name],
      `note for unknown response field ${name}`,
    );
  // The generated JSON Schemas are usable, and the examples satisfy both
  // them and the zod schemas the routes are tested against.
  const post = spec.paths["/api/v1/publish"].post;
  const requestExample =
    post.requestBody.content["application/json"].examples.html.value;
  agentPublishInputSchema.parse(requestExample);
  z.fromJSONSchema(request).parse(requestExample);
  const published = z.fromJSONSchema(spec.components.schemas.PublishResponse);
  for (const example of Object.values<any>(
    post.responses["200"].content["application/json"].examples,
  )) {
    publishResponseSchema.parse(example.value);
    published.parse(example.value);
  }
  const problem = z.fromJSONSchema(spec.components.schemas.Problem);
  for (const [status, operation] of Object.entries<any>({
    ...post.responses,
    ...spec.paths["/api/v1/status/{artifactId}"].get.responses,
  }))
    if (Number(status) >= 400)
      for (const example of Object.values<any>(
        operation.content["application/json"].examples,
      )) {
        problemSchema.parse(example.value);
        problem.parse(example.value);
      }
});

test("every route publish-api.ts registers is in /openapi.json", async () => {
  const routes: string[] = [];
  const probe = Fastify();
  probe.addHook("onRoute", (route) => {
    for (const method of [route.method].flat())
      if (method !== "HEAD")
        routes.push(
          `${method.toLowerCase()} ${route.url.replace(/:(\w+)/g, "{$1}")}`,
        );
  });
  await registerPublishApi(probe);
  await probe.ready();
  await probe.close();
  const spec = openApiDocument(origin);
  const documented = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item).map((method) => `${method} ${path}`),
  );
  assert.ok(routes.length >= 3);
  assert.deepEqual(documented.sort(), routes.sort());
});

test("GET /.well-known/agent-skills: discovery index with a matching digest", async () => {
  for (const path of [
    "/.well-known/agent-skills",
    "/.well-known/agent-skills/index.json",
  ]) {
    const response = await get(path);
    assertPublic(response, "application/json; charset=utf-8");
    const index = response.json();
    assert.equal(
      index.$schema,
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    );
    assert.equal(index.skills.length, 1);
    const [entry] = index.skills;
    assert.equal(entry.name, SKILL_NAME);
    assert.equal(entry.type, "skill-md");
    assert.ok(entry.description.length <= 1024);
    assert.equal(
      entry.url,
      `${origin}/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`,
    );
    const skill = await get(new URL(entry.url).pathname);
    assertPublic(skill, "text/markdown; charset=utf-8");
    assert.equal(
      entry.digest,
      `sha256:${createHash("sha256").update(skill.rawPayload).digest("hex")}`,
    );
    assert.match(skill.body, new RegExp(`^---\\nname: ${SKILL_NAME}\\n`));
    assert.ok(skill.body.includes(`${origin}/connect`));
    assert.ok(skill.body.includes("polka_publish"));
    assert.match(skill.body, /moderation: "held"/);
    assert.match(skill.body, /## Never/);
    onlyOrigin(skill.body, origin);
  }
});

test("skills/polka/SKILL.md is the generated skill for the hosted origin", () => {
  const committed = readFileSync(`skills/${SKILL_NAME}/SKILL.md`, "utf8");
  assert.equal(
    committed,
    skillMarkdown(HOSTED_ORIGIN),
    "skills/polka/SKILL.md is stale: run npm run gen:skill",
  );
  const front = committed.match(/^---\n([\s\S]*?)\n---\n/)![1];
  assert.match(front, /^name: polka$/m);
  const description = JSON.parse(front.match(/^description: (.*)$/m)![1]);
  assert.ok(description.length > 100 && description.length <= 1024);
});

test("another APP_ORIGIN is substituted everywhere", () => {
  for (const text of [
    llmsText(OTHER),
    skillMarkdown(OTHER),
    JSON.stringify(openApiDocument(OTHER)),
    JSON.stringify(agentSkillsIndex(OTHER)),
    connectGuide(OTHER),
  ]) {
    assert.ok(text.includes(OTHER));
    assert.doesNotMatch(text, /polochka\.app/);
    onlyOrigin(text, OTHER);
  }
  assert.ok(connectGuide(OTHER).includes(`${OTHER}/llms.txt`));
});
