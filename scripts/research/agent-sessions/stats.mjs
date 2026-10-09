// Stage 0: the shape of the dataset build-dataset.mjs wrote — per session,
// per day, cardinalities — for the storage experiment and the plan.
//   node stats.mjs <dataset-dir>
import { createReadStream, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const dir = process.argv[2];
async function* rows(prefix) {
  for (const file of readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".ndjson")))
    for await (const line of createInterface({ input: createReadStream(join(dir, file)) }))
      if (line) yield JSON.parse(line);
}
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
};
const sessions = [];
for await (const s of rows("sessions.")) if (!s.failed) sessions.push(s);
const days = new Map();
for (const s of sessions)
  if (s.startedAt) {
    const d = new Date(s.startedAt).toISOString().slice(0, 10);
    days.set(d, (days.get(d) ?? 0) + 1);
  }
const calls = {
  n: 0,
  kinds: new Map(),
  tools: new Set(),
  mcp: new Set(),
  argv0: new Map(),
  templates: new Set(),
  hosts: new Map(),
  status: new Map(),
  network: 0,
  perSession: new Map(),
  outBytes: 0,
  inBytes: 0,
};
for await (const c of rows("tool_calls.")) {
  calls.n++;
  calls.kinds.set(c.kind, (calls.kinds.get(c.kind) ?? 0) + 1);
  calls.tools.add(c.tool);
  if (c.mcpServer) calls.mcp.add(c.mcpServer);
  if (c.argv0) calls.argv0.set(c.argv0, (calls.argv0.get(c.argv0) ?? 0) + 1);
  if (c.template) calls.templates.add(c.template);
  for (const h of c.hosts ?? []) calls.hosts.set(h, (calls.hosts.get(h) ?? 0) + 1);
  calls.status.set(c.status, (calls.status.get(c.status) ?? 0) + 1);
  if (c.network) calls.network++;
  calls.outBytes += c.outputBytes ?? 0;
  calls.inBytes += c.inputBytes ?? 0;
  calls.perSession.set(c.sid, (calls.perSession.get(c.sid) ?? 0) + 1);
}
const perSession = sessions.map((s) => s.toolCallCount);
const raw = sessions.map((s) => s.rawBytes);
const tokens = sessions.reduce(
  (a, s) => a + s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite,
  0,
);
const sortedDays = [...days.keys()].sort();
const top = (map, n) =>
  [...map]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
const unknown = new Map();
for (const s of sessions)
  for (const [k, v] of Object.entries(s.unknownRecordTypes ?? {})) unknown.set(k, (unknown.get(k) ?? 0) + v);
const statuses = new Map();
for (const s of sessions) statuses.set(s.secretsStatus, (statuses.get(s.secretsStatus) ?? 0) + 1);
const result = {
  sessions: sessions.length,
  bySource: Object.fromEntries(
    [...new Set(sessions.map((s) => s.source))].map((src) => [src, sessions.filter((s) => s.source === src).length]),
  ),
  days: {
    first: sortedDays[0],
    last: sortedDays.at(-1),
    active: days.size,
    perActiveDay: {
      p50: pct([...days.values()], 50),
      p90: pct([...days.values()], 90),
      max: Math.max(...days.values()),
    },
  },
  rawMB: {
    total: Math.round(raw.reduce((a, b) => a + b, 0) / 1048576),
    p50: +(pct(raw, 50) / 1048576).toFixed(2),
    p90: +(pct(raw, 90) / 1048576).toFixed(1),
    max: +(Math.max(...raw) / 1048576).toFixed(1),
  },
  toolCallsPerSession: {
    p50: pct(perSession, 50),
    p90: pct(perSession, 90),
    p99: pct(perSession, 99),
    max: Math.max(...perSession),
  },
  toolCalls: calls.n,
  kinds: Object.fromEntries(calls.kinds),
  status: Object.fromEntries(calls.status),
  networkCalls: calls.network,
  cardinality: {
    tools: calls.tools.size,
    mcpServers: calls.mcp.size,
    argv0: calls.argv0.size,
    templates: calls.templates.size,
    hosts: calls.hosts.size,
  },
  topArgv0: top(calls.argv0, 15),
  topHosts: top(calls.hosts, 12),
  ioMB: { toolInput: Math.round(calls.inBytes / 1048576), toolOutput: Math.round(calls.outBytes / 1048576) },
  tokensBillions: +(tokens / 1e9).toFixed(2),
  secretsStatus: Object.fromEntries(statuses),
  unknownRecordTypes: Object.fromEntries([...unknown].slice(0, 10)),
  parseMs: {
    p50: pct(
      sessions.map((s) => s.parseMs),
      50,
    ),
    p99: pct(
      sessions.map((s) => s.parseMs),
      99,
    ),
  },
};
console.log(JSON.stringify(result, null, 2));
