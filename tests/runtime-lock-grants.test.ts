// A row lock (FOR SHARE, FOR UPDATE) needs the UPDATE privilege, and the app
// runs as a role without it on some tables (deploy/runtime-grants.sql). The
// test suites run as the schema owner and never see the refusal (42501), so
// this reads the SQL itself: no query may lock a table the runtime role
// cannot update.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function grantedTables() {
  const sql = readFileSync(join(root, "deploy/runtime-grants.sql"), "utf8");
  const all = new Set<string>();
  const updatable = new Set<string>();
  for (const grant of sql.matchAll(/GRANT\s+([A-Z, ]+?)\s+ON\s+(?:TABLE\s+)?([\s\S]+?)\s+TO\s+:"runtime_role"/g)) {
    for (const raw of grant[2].split(",")) {
      const table = raw.trim().replace(/^public\./, "");
      if (!/^\w+$/.test(table)) continue;
      all.add(table);
      if (grant[1].includes("UPDATE")) updatable.add(table);
    }
  }
  return { all, updatable };
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? sources(path) : /\.ts$/.test(name) ? [path] : [];
  });
}

test("no query locks a row of a table the runtime role cannot update", () => {
  const { all, updatable } = grantedTables();
  const readOnly = new Set([...all].filter((table) => !updatable.has(table)));
  assert.ok(readOnly.has("template_library_viewer_grants"), "the grants file was read");
  const found: string[] = [];
  for (const file of [...sources(join(root, "apps/server")), ...sources(join(root, "packages"))]) {
    const text = readFileSync(file, "utf8");
    for (const lock of text.matchAll(/\bFOR\s+(?:NO KEY UPDATE|UPDATE|SHARE|KEY SHARE)\b(?:\s+OF\s+([\w, ]+))?/g)) {
      const line = text.slice(0, lock.index).split("\n").length;
      // The query text before the lock: back to its opening quote or backtick.
      const before = text.slice(Math.max(0, lock.index! - 3000), lock.index);
      const start = Math.max(before.lastIndexOf("`"), before.lastIndexOf('"'));
      const query = before.slice(start + 1);
      const tables = [...query.matchAll(/\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(?!(?:JOIN|LEFT|RIGHT|INNER|WHERE|ON|SET|FOR|GROUP|ORDER|LIMIT|USING|CROSS)\b)(\w+))?/gi)]
        .map((m) => ({ table: m[1], alias: m[2] ?? m[1] }));
      const locked = lock[1]
        ? tables.filter(({ table, alias }) => lock[1].split(",").map((n) => n.trim()).some((n) => n === alias || n === table))
        : tables;
      for (const { table } of locked)
        if (readOnly.has(table)) found.push(`${file.slice(root.length)}:${line} locks ${table}`);
    }
  }
  assert.deepEqual(found, []);
});
