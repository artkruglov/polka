// Regenerate the skill packages `npx skills add artkruglov/polka` installs
// (skills/polka/SKILL.md, skills/polka-organize/SKILL.md) from agentSkills()
// for the hosted origin. The server serves the same texts with its own
// APP_ORIGIN at /.well-known/agent-skills/<name>/SKILL.md;
// tests/agent-discovery.test.ts fails when a committed file is stale.
//
//   npm run gen:skill
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HOSTED_ORIGIN, agentSkills } from "../apps/server/agent-discovery.ts";

for (const skill of agentSkills(HOSTED_ORIGIN)) {
  const target = new URL(`../skills/${skill.name}/SKILL.md`, import.meta.url);
  mkdirSync(new URL(".", target), { recursive: true });
  writeFileSync(target, skill.markdown);
  console.log(`wrote ${fileURLToPath(target)}`);
}
