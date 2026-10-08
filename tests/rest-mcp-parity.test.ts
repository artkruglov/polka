// REST parity with MCP (docs/dev/AGENT_ACCESS_IMPLEMENTATION.md, principles):
// every MCP tool either has a documented REST counterpart or is listed here as
// MCP-only on purpose. A new tool fails this test until someone decides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpToolCatalog } from "../apps/server/agent-discovery.ts";
import { openApiDocument } from "../apps/server/openapi.ts";

/** MCP tool → "METHOD /path" in /openapi.json. */
const REST: Record<string, string> = {
  polka_publish: "post /api/v1/publish",
  polka_list: "get /api/v1/works",
  polka_get_artifact: "get /api/v1/works/{artifactId}",
  polka_snapshot: "get /api/v1/snapshot",
  polka_status: "get /api/v1/status/{artifactId}",
  polka_open_shelf: "post /api/v1/sign-in-link",
  polka_project_upload: "post /api/v1/projects",
  polka_read_source: "get /api/v1/works/{artifactId}/files",
  polka_list_files: "get /api/v1/works/{artifactId}/files",
  polka_read_file: "get /api/v1/works/{artifactId}/file",
  polka_change_files: "post /api/v1/works/{artifactId}/changes",
};
/** Tools that exist for a chat session and have no HTTP twin yet (each with its reason). */
const MCP_ONLY: Record<string, string> = {
  polka_context: "MCP onboarding; REST clients read /openapi.json and /llms.txt",
  polka_capture: "chat client sends bytes in one JSON-RPC call; REST uses publish/projects",
  polka_prepare_preview: "interactive build of a capture, MCP flow",
  polka_revise: "REST: POST /api/v1/works/{id}/edits and publish with artifactId",
  polka_note: "comments: MCP for the owner's agent",
  polka_comments: "comments: MCP for the owner's agent",
  polka_resolve_comment: "comments: MCP for the owner's agent",
  polka_share: "links: MCP; REST publish returns the link",
  polka_revoke_share: "links: MCP",
  polka_save_link: "saved links: MCP",
  polka_list_folders: "folders: MCP",
  polka_create_folder: "folders: MCP",
  polka_rename_folder: "folders: MCP",
  polka_delete_folder: "folders: MCP",
  polka_move: "folders: MCP",
  polka_update_artifact: "management: MCP",
  polka_trash: "management: MCP",
  polka_restore: "management: MCP",
  polka_list_template_libraries: "templates: MCP",
  polka_list_templates: "templates: MCP",
  polka_sessions: "agent sessions: the owner reads them on the web page; the CLI only uploads",
  polka_session_stats: "agent sessions: the owner reads them on the web page; the CLI only uploads",
};

test("every MCP tool has a REST twin in the OpenAPI document or an explicit reason not to", () => {
  const paths = openApiDocument("https://example.test").paths as Record<string, Record<string, unknown>>;
  const present = new Set(
    Object.entries(paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method} ${path}`)),
  );
  const tools = mcpToolCatalog().map((tool) => tool.name);
  const undecided = tools.filter((name) => !(name in REST) && !(name in MCP_ONLY));
  assert.deepEqual(undecided, [], `decide REST or MCP-only for: ${undecided.join(", ")}`);
  for (const [tool, route] of Object.entries(REST)) {
    if (tools.includes(tool)) assert.ok(present.has(route), `${tool} → ${route} is not in /openapi.json`);
  }
  // No stale entries for tools that no longer exist.
  // (A tool behind an installation flag may be absent from the catalog.)
  const conditional = new Set(["polka_prepare_preview"]);
  const stale = [...Object.keys(REST), ...Object.keys(MCP_ONLY)].filter((name) => !tools.includes(name) && !conditional.has(name));
  assert.deepEqual(stale, [], `tools that are gone: ${stale.join(", ")}`);
});
