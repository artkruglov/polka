#!/usr/bin/env node
// The skill market of the swarm stand (deploy/contour-stand/README.md, «Рой»).
// A skill enters the catalog when it is admitted: its files are hashed and
// the digest is written to catalog/index.json. A sandbox gets a skill only
// from the catalog and only if its files still match the admitted digest.
// No dependencies.
//
//   catalog.mjs admit <skill>    hash the skill's folder and record it as admitted
//   catalog.mjs verify           every skill against its admitted digest
//   catalog.mjs list             skills with version, owner and what they may propose
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseProfile } from "./dispatcher.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILLS = join(HERE, "catalog", "skills");
const INDEX = join(HERE, "catalog", "index.json");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (entry.isFile() && !entry.name.endsWith(".pyc")) out.push(path);
  }
  return out;
}

/** The digest of a folder: every file's path and hash, in a stable order. */
export async function treeDigest(dir) {
  const lines = [];
  for (const path of (await files(dir)).sort()) lines.push(`${relative(dir, path)}\0${sha256(await readFile(path))}`);
  return sha256(lines.join("\n"));
}

/** The front matter of SKILL.md: name, version, owner, effects, inputs, match… */
export async function skillMeta(dir) {
  const text = await readFile(join(dir, "SKILL.md"), "utf8");
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!head) throw new Error(`${dir}/SKILL.md has no front matter`);
  return parseProfile(head[1]);
}

export async function index() {
  return JSON.parse(await readFile(INDEX, "utf8").catch(() => '{"skills":{}}'));
}

/** A skill as a sandbox may get it: admitted, and unchanged since. */
export async function verifiedSkill(name, dir = join(SKILLS, name)) {
  const entry = (await index()).skills[name];
  if (!entry) throw new Error(`навык ${name} не допущен в каталог`);
  const digest = await treeDigest(dir);
  if (digest !== entry.sha256)
    throw new Error(`навык ${name} изменён после допуска (${digest.slice(0, 12)} ≠ ${entry.sha256.slice(0, 12)})`);
  return { name, dir, digest, meta: await skillMeta(dir), ...entry };
}

/** Skills whose «match» words occur in a text, best first. */
export async function findSkills(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const name of Object.keys((await index()).skills)) {
    const meta = await skillMeta(join(SKILLS, name));
    const hits = (meta.match ?? []).filter((w) => lower.includes(w)).length;
    if (hits) found.push({ name, meta, hits });
  }
  return found.sort((a, b) => b.hits - a.hits);
}

const main = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (main) {
  const [command, name] = process.argv.slice(2);
  if (command === "admit" && name) {
    const all = await index();
    const meta = await skillMeta(join(SKILLS, name));
    all.skills[name] = {
      version: meta.version,
      owner: meta.owner,
      sha256: await treeDigest(join(SKILLS, name)),
      admitted: new Date().toISOString().slice(0, 10),
    };
    all.skills = Object.fromEntries(Object.entries(all.skills).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(INDEX, JSON.stringify(all, null, 2) + "\n");
    console.log(`${name}@${meta.version} ${all.skills[name].sha256.slice(0, 12)}`);
  } else if (command === "verify" || command === "list") {
    let bad = 0;
    for (const [skill, entry] of Object.entries((await index()).skills)) {
      try {
        const s = await verifiedSkill(skill);
        const extra =
          command === "list" ? `  ${s.meta.description} · эффекты: ${(s.meta.effects ?? []).join(", ")}` : "";
        console.log(`ok   ${skill}@${entry.version} ${entry.owner}${extra}`);
      } catch (error) {
        bad = 1;
        console.log(`fail ${skill}: ${error.message}`);
      }
    }
    process.exitCode = bad;
  } else {
    console.log("usage: catalog.mjs admit <skill> | verify | list");
    process.exitCode = 2;
  }
}
