import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Every MCP tool the server can register is named in the user-facing guide
// (docs/connect-agents.md, «Инструменты MCP»), so a new tool cannot ship
// undocumented. Static: reads the registration source, no server or database.
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("every registered polka_* MCP tool is documented in connect-agents.md", async () => {
  const source = await read("apps/server/mcp-server.ts");
  const tools = [
    ...new Set([...source.matchAll(/registerTool\(\s*"(polka_[a-z_]+)"/g)].map((match) => match[1]!)),
  ].sort();
  // Guard the pattern itself: a refactor that hides the names must fail
  // here, not pass with an empty list.
  assert.ok(tools.length >= 30, `found only ${tools.length} tools`);
  const guide = await read("docs/connect-agents.md");
  const missing = tools.filter((tool) => !guide.includes(`\`${tool}\``));
  assert.deepEqual(missing, [], `undocumented MCP tools: ${missing.join(", ")}`);
});
