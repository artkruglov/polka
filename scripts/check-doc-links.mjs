#!/usr/bin/env node
// Checks every relative link and #anchor in the tracked Markdown files:
// the target file exists (exact case, as on GitHub) and the anchor matches a
// heading slug the way GitHub builds it (Cyrillic kept, punctuation dropped).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, basename } from "node:path";

const files = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

const anchorsCache = new Map();
function anchors(file) {
  if (!anchorsCache.has(file)) {
    const seen = new Map();
    const set = new Set();
    let fenced = false;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const match = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (!match) continue;
      const base = slug(match[1]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      set.add(count ? `${base}-${count}` : base);
    }
    anchorsCache.set(file, set);
  }
  return anchorsCache.get(file);
}

// Exact-case existence: macOS is case-insensitive, GitHub is not.
function existsExact(path) {
  if (!existsSync(path)) return false;
  const parts = normalize(path).split("/").filter(Boolean);
  let current = path.startsWith("/") ? "/" : ".";
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      current = join(current, "..");
      continue;
    }
    if (!readdirSync(current).includes(part)) return false;
    current = join(current, part);
  }
  return true;
}

let broken = 0;
let checked = 0;
for (const file of files) {
  let fenced = false;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return;
      for (const [, target] of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        if (/^(?:[a-z]+:|\/\/)/i.test(target)) continue;
        const [path, anchor] = target.split("#");
        const resolved = path ? normalize(join(dirname(file), decodeURI(path))) : file;
        checked++;
        let problem = "";
        if (path && !existsExact(resolved)) problem = "missing file";
        else if (anchor && resolved.endsWith(".md") && !anchors(resolved).has(decodeURIComponent(anchor)))
          problem = `missing anchor #${decodeURIComponent(anchor)}`;
        if (problem) {
          broken++;
          console.log(`${file}:${index + 1}: ${target} (${problem})`);
        }
      }
    });
}
console.log(`checked ${checked} links in ${files.length} files, broken: ${broken}`);
if (broken) process.exitCode = 1;
