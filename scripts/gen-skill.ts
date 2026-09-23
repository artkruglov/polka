// Regenerate skills/polka/SKILL.md, the package `npx skills add artkruglov/polka`
// installs, from skillMarkdown() for the hosted origin. The server serves the
// same text with its own APP_ORIGIN at /.well-known/agent-skills/polka/SKILL.md;
// tests/agent-discovery.test.ts fails when the committed file is stale.
//
//   npm run gen:skill
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HOSTED_ORIGIN,
  SKILL_NAME,
  skillMarkdown,
} from "../apps/server/agent-discovery.ts";

const target = new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url);
mkdirSync(new URL(".", target), { recursive: true });
writeFileSync(target, skillMarkdown(HOSTED_ORIGIN));
console.log(`wrote ${fileURLToPath(target)}`);
