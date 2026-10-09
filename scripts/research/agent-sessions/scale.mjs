// Stage 0: a company-sized tool-call stream from this machine's real sessions.
// Real sessions (their tool calls, in order, with their real gaps) are dealt
// to synthetic developers and days until each developer-day holds about as
// many calls as the real developer's average active day. Deterministic
// (seeded), so Postgres and ClickHouse get exactly the same rows.
//   node scale.mjs <dataset-dir> --devs 1000 --days 10 --format pg|ch > stream
import { createReadStream, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [dir, ...args] = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const devs = Number(opt("devs", 1000));
const days = Number(opt("days", 10));
const format = opt("format", "pg");
const perDevDay = Number(opt("per-dev-day", 2000));
const start = Date.parse(opt("start", "2026-09-01T00:00:00Z"));

let seed = 42;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const uuid = (text) => {
  const h = createHash("sha1").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const sessions = new Map();
for (const file of readdirSync(dir).filter((f) => f.startsWith("tool_calls.")))
  for await (const line of createInterface({ input: createReadStream(join(dir, file)) })) {
    if (!line) continue;
    const c = JSON.parse(line);
    if (!sessions.has(c.sid)) sessions.set(c.sid, []);
    sessions.get(c.sid).push(c);
  }
const pool = [...sessions.values()].filter((calls) => calls.length > 0);
const projects = 120;

const pgText = (v) =>
  v === null || v === undefined
    ? "\\N"
    : String(v).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const pgArray = (items) => `{${items.map((h) => `"${h.replace(/["\\]/g, "")}"`).join(",")}}`;
const out = process.stdout;
let buffer = "";
const flush = async () => {
  if (!out.write(buffer)) await new Promise((r) => out.once("drain", r));
  buffer = "";
};

let rows = 0;
for (let dev = 0; dev < devs; dev++) {
  const account = uuid(`account-${dev}`);
  const tenant = uuid(`tenant-${dev % 20}`);
  for (let day = 0; day < days; day++) {
    let calls = 0;
    let n = 0;
    const dayStart = start + day * 86_400_000 + 8 * 3_600_000;
    while (calls < perDevDay * (0.4 + random() * 1.2)) {
      const real = pool[Math.floor(random() * pool.length)];
      const session = uuid(`${dev}-${day}-${n++}`);
      const project = Math.floor(random() * projects);
      const offset = Math.floor(random() * 10 * 3_600_000);
      const t0 = real[0].t || 0;
      for (const c of real) {
        const at = new Date(dayStart + offset + Math.max(0, Math.min((c.t || t0) - t0, 6 * 3_600_000))).toISOString();
        const row = [
          tenant,
          account,
          session,
          c.seq,
          at,
          c.tool,
          c.kind,
          c.mcpServer,
          c.status,
          c.durationMs,
          c.exitCode ?? null,
          c.inputBytes,
          c.outputBytes,
          c.argv0 ?? null,
          c.template ?? null,
          c.hosts ?? [],
          !!c.network,
          `project-${project}`,
        ];
        if (format === "pg")
          buffer +=
            row.map((v, i) => (i === 15 ? pgArray(v) : i === 16 ? (v ? "t" : "f") : pgText(v))).join("\t") + "\n";
        else
          buffer +=
            JSON.stringify({
              tenant_id: row[0],
              account_id: row[1],
              session_id: row[2],
              seq: row[3],
              at: row[4].replace("T", " ").replace("Z", ""),
              tool: row[5],
              kind: row[6],
              mcp_server: row[7] ?? "",
              status: row[8],
              duration_ms: row[9] ?? 0,
              exit_code: row[10] ?? -1,
              input_bytes: row[11],
              output_bytes: row[12],
              argv0: row[13] ?? "",
              template: row[14] ?? "",
              hosts: row[15],
              network: row[16] ? 1 : 0,
              project_key: row[17],
            }) + "\n";
        rows++;
        calls++;
        if (buffer.length > 1 << 20) await flush();
      }
    }
  }
}
await flush();
process.stderr.write(JSON.stringify({ rows, devs, days }) + "\n");
