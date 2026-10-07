#!/usr/bin/env node
// Write the Полка plugin repository (github.com/artkruglov/polka-plugin) into
// a folder: the Claude Code and Codex marketplace manifests, .mcp.json and
// skills/, copied from this repository. That repository is a few kilobytes,
// so `plugin marketplace add` clones it quickly where cloning the whole core
// (tens of megabytes of history) breaks on a slow or sandboxed network.
//
//   node scripts/plugin-repo.mjs ../polka-plugin   # then commit and push there
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/plugin-repo.mjs <folder>");
  process.exit(2);
}
const out = resolve(target);
const copy = (path) => {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  cpSync(join(root, path), join(out, path), { recursive: true });
};
for (const path of ["skills", "hooks", "scripts"]) rmSync(join(out, path), { recursive: true, force: true });
for (const path of [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  ".agents/plugins/marketplace.json",
  ".mcp.json",
  "skills",
  // Agent sessions: the SessionEnd hook and the CLI it runs (off unless POLKA_SESSIONS=on).
  "hooks",
  "scripts/polka-sessions.mjs",
  "LICENSE",
])
  copy(path);
const { version } = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
writeFileSync(
  join(out, "README.md"),
  `# Полка — плагин для Claude Code и Codex

Плагин [Полки](https://polochka.app): подключает удалённый MCP-сервер \`https://polochka.app/mcp\` (вход через OAuth в браузере, токен не нужен) и ставит скиллы Полки. Агент сохраняет страницы, отчёты и прототипы на вашу полку и даёт ссылку, которую открывают без аккаунта.

**Claude Code**

\`\`\`
claude plugin marketplace add artkruglov/polka-plugin && claude plugin install polka@polka
\`\`\`

Затем в Claude Code: \`/mcp\` → \`plugin:polka:polka\` → Authenticate.

**Codex**

\`\`\`
codex plugin marketplace add artkruglov/polka-plugin && codex plugin add polka@polka
\`\`\`

Затем \`codex mcp login polka\`.

**Сессии агентов** (по желанию): плагин ставит хук \`SessionEnd\`, который отправляет закончившуюся сессию Claude Code на вашу полку, скрыв секреты ещё на компьютере. Он ничего не делает, пока вы не включите: \`node scripts/polka-sessions.mjs login\` (токен с правом «Сессии агентов») и \`POLKA_SESSIONS=on\` в окружении. Подробнее — [AGENT_SESSIONS](https://github.com/artkruglov/polka/blob/main/docs/specs/AGENT_SESSIONS.md).

**Без плагина** — только MCP-сервер: \`claude mcp add --transport http --scope user polka https://polochka.app/mcp\` или \`codex mcp add polka --url https://polochka.app/mcp\`. Скилл отдельно: \`npx skills add artkruglov/polka-plugin\`.

Версия ${version}. Этот репозиторий собирается из [artkruglov/polka](https://github.com/artkruglov/polka) командой \`node scripts/plugin-repo.mjs\`: правки вносятся там. Лицензия AGPL-3.0.
`,
);
console.log(`wrote the plugin repository ${version} to ${out}`);
