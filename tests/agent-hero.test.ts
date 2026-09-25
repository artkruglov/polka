// The home shelf's agent-first top (features/agent-hero) and the plugin
// manifests that make the repository a Claude Code and Codex marketplace
// (.claude-plugin/, .codex-plugin/, .agents/plugins/, .mcp.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentHeroView,
  type AgentHeroProps,
} from "../apps/web/src/features/agent-hero/index.tsx";
import {
  CLAUDE_PLUGIN_INSTALL,
  CODEX_LOGIN,
  CODEX_PLUGIN_INSTALL,
  HERO_CLIENT_IDS,
  SKILL_INSTALL,
  heroClient,
  heroSetup,
} from "../apps/web/src/entities/onboarding/agent-setup.ts";
import {
  CLAUDE_PLUGIN_INSTALL as SERVER_CLAUDE_PLUGIN_INSTALL,
  CODEX_PLUGIN_INSTALL as SERVER_CODEX_PLUGIN_INSTALL,
  connectGuide,
} from "../apps/server/connect-guide.ts";
import type { AgentConnection } from "../packages/contracts/index.ts";

const origin = "https://polochka.app";
const noop = () => {};

function hero(over: Partial<AgentHeroProps> = {}) {
  return renderToStaticMarkup(
    React.createElement(AgentHeroView, {
      origin,
      connections: { status: "ready", active: [] },
      hidden: false,
      client: "claude-ai",
      onClient: noop,
      onHide: noop,
      onShow: noop,
      onUpload: noop,
      ...over,
    }),
  );
}

const connection = (name: string): AgentConnection =>
  ({
    id: "5b0f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
    name,
    scopes: ["capture", "context"],
    audience: `${origin}/mcp`,
    status: "seen",
    kind: "oauth",
    createdAt: "2026-09-20T10:00:00.000Z",
    expiresAt: "2026-10-20T10:00:00.000Z",
    lastSeenAt: "2026-09-25T10:00:00.000Z",
  }) as AgentConnection;

test("a new shelf leads with «Подключите агента»: four clients, one step each, no link field", () => {
  const html = hero();
  assert.match(html, /<h1[^>]*>Подключите агента — он сам сохранит работу на полку<\/h1>/);
  for (const name of ["Claude", "Claude Code", "Codex", "Другой MCP-клиент"])
    assert.ok(html.includes(`>${name}</button>`), name);
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-selected="true"[^>]*>Claude</);
  // Claude: the connector path and the address with a copy button.
  assert.match(html, /Settings → Connectors → Add custom connector/);
  assert.ok(html.includes(`<code>${origin}/mcp</code>`));
  assert.match(html, /Скопировать адрес/);
  // The full version and the file upload stay one click away.
  assert.match(html, /href="\/settings\/agents\?client=claude-ai"/);
  assert.match(html, /Загрузить файл/);
  // Link import is gone from the top of the shelf.
  assert.doesNotMatch(html, /Вставьте ссылку|type="url"|action="\/bring"|один клик/);
});

test("each client's hero step is the command /connect gives the agent", () => {
  const guide = connectGuide(origin);
  assert.equal(CLAUDE_PLUGIN_INSTALL, SERVER_CLAUDE_PLUGIN_INSTALL);
  assert.equal(CODEX_PLUGIN_INSTALL, SERVER_CODEX_PLUGIN_INSTALL);
  for (const id of HERO_CLIENT_IDS) {
    const setup = heroSetup(origin, id);
    assert.ok(setup.copies.length >= 1, id);
    for (const copy of setup.copies) {
      if (copy.kind === "url") assert.equal(copy.value, `${origin}/mcp`);
      else assert.ok(guide.includes(copy.value), `guide lacks ${copy.value}`);
    }
    const html = hero({ client: id });
    assert.match(html, new RegExp(`data-client="${id}"`));
    assert.match(html, new RegExp(`href="/settings/agents\\?client=${id}"`));
  }
  assert.equal(heroSetup(origin, "claude-code").copies[0].value, CLAUDE_PLUGIN_INSTALL);
  assert.equal(heroSetup(origin, "codex").copies[0].value, CODEX_PLUGIN_INSTALL);
  assert.ok(heroSetup(origin, "codex").then.includes(CODEX_LOGIN));
  assert.ok(guide.includes(CODEX_LOGIN));
  const other = heroSetup(origin, "other").copies.map((copy) => copy.value);
  assert.deepEqual(other, [`${origin}/mcp`, SKILL_INSTALL]);
  // The agents page's remembered choice picks the tab; ChatGPT falls back to Claude.
  assert.equal(heroClient("codex"), "codex");
  assert.equal(heroClient("chatgpt"), "claude-ai");
  assert.equal(heroClient(null), "claude-ai");
});

test("with a connected agent the hero is one slim line", () => {
  const html = hero({
    connections: { status: "ready", active: [connection("Claude Code")] },
  });
  assert.match(html, /agent-hero--slim/);
  assert.match(html, /Подключено: Claude Code\./);
  assert.match(html, /Сохрани это на Полку/);
  assert.match(html, /href="\/settings\/agents"/);
  assert.match(html, /Загрузить файл/);
  assert.doesNotMatch(html, /role="tablist"|Подключите агента/);
  const two = hero({
    connections: {
      status: "ready",
      active: [connection("Claude Code"), connection("Codex")],
    },
  });
  assert.match(two, /Подключено: Claude Code и ещё 1\./);
});

test("hidden or still checking: one line, and the steps come back on request", () => {
  const hidden = hero({ hidden: true });
  assert.match(hidden, /agent-hero--slim/);
  assert.match(hidden, /Подключить агента/);
  assert.doesNotMatch(hidden, /role="tablist"/);
  const loading = hero({ connections: { status: "loading" } });
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Проверяем подключения/);
  // A failed check still shows the steps: they work either way.
  const failed = hero({ connections: { status: "error" } });
  assert.match(failed, /role="tablist"/);
  assert.match(failed, /Не удалось проверить подключения/);
});

const json = async (path: string) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

test("the repository is a Claude Code and Codex marketplace with one plugin: the MCP server and every skill", async () => {
  const mcp = await json(".mcp.json");
  assert.deepEqual(mcp, {
    mcpServers: { polka: { type: "http", url: "https://polochka.app/mcp" } },
  });

  const claudePlugin = await json(".claude-plugin/plugin.json");
  const claudeMarket = await json(".claude-plugin/marketplace.json");
  assert.equal(claudePlugin.name, "polka");
  assert.equal(claudeMarket.name, "polka");
  assert.deepEqual(
    claudeMarket.plugins.map((p: { name: string; source: string }) => [p.name, p.source]),
    [["polka", "./"]],
  );
  // Skills come from the skills/ directory, not a hardcoded list; the server from .mcp.json.
  assert.equal(claudePlugin.skills, undefined);
  assert.equal(claudePlugin.mcpServers, undefined);

  const codexPlugin = await json(".codex-plugin/plugin.json");
  const codexMarket = await json(".agents/plugins/marketplace.json");
  assert.equal(codexPlugin.name, "polka");
  assert.equal(codexPlugin.skills, "./skills/");
  assert.equal(codexPlugin.mcpServers, "./.mcp.json");
  assert.equal(codexMarket.name, "polka");
  assert.deepEqual(codexMarket.plugins[0].source, { source: "local", path: "./" });
  assert.equal(codexMarket.plugins[0].name, "polka");

  // The install commands name this marketplace and plugin.
  assert.match(CLAUDE_PLUGIN_INSTALL, /install polka@polka$/);
  assert.match(CODEX_PLUGIN_INSTALL, /add polka@polka$/);

  // Every skill directory carries a SKILL.md the plugins pick up.
  const skills = await readdir(new URL("../skills/", import.meta.url), { withFileTypes: true });
  const dirs = skills.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(dirs.includes("polka"));
  for (const dir of dirs) {
    const text = await readFile(new URL(`../skills/${dir}/SKILL.md`, import.meta.url), "utf8");
    assert.match(text, new RegExp(`^---\\r?\\n(?:.*\\r?\\n)*?name: ["']?${dir}["']?\\s*\\r?\\n`), dir);
  }
  const versions = new Set([
    claudePlugin.version,
    codexPlugin.version,
    (await json("package.json")).version,
  ]);
  assert.equal(versions.size, 1, "plugin versions follow package.json");
});
