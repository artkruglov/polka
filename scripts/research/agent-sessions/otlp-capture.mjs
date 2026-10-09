// Stage 0: what Claude Code and Codex send over OpenTelemetry. A dependency-free
// OTLP/HTTP JSON receiver: every request body is appended to <out>/<signal>.ndjson
// (logs, metrics, traces). Protobuf bodies are counted, not decoded.
//   node otlp-capture.mjs <out-dir> [--port 4318]
//   CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp \
//   OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 claude -p "…"
// Then `node otlp-capture.mjs <out-dir> --summary` prints event names and attribute keys
// (never values) per signal.
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const [out, ...args] = process.argv.slice(2);
if (!out) throw new Error("usage: otlp-capture.mjs <out-dir> [--port 4318] [--summary]");
mkdirSync(out, { recursive: true });

if (args.includes("--summary")) {
  const summary = {};
  for (const signal of ["logs", "metrics", "traces"]) {
    const file = join(out, `${signal}.ndjson`);
    if (!existsSync(file)) continue;
    const names = {};
    const resourceKeys = new Set();
    const add = (name, attrs) => {
      const entry = (names[name] ??= { count: 0, keys: new Set() });
      entry.count++;
      for (const a of attrs ?? []) entry.keys.add(a.key);
    };
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const body = JSON.parse(line);
      for (const r of body.resourceLogs ?? body.resourceMetrics ?? body.resourceSpans ?? []) {
        for (const a of r.resource?.attributes ?? []) resourceKeys.add(a.key);
        for (const s of r.scopeLogs ?? r.scopeMetrics ?? r.scopeSpans ?? []) {
          for (const rec of s.logRecords ?? []) {
            const name =
              rec.attributes?.find((a) => a.key === "event.name")?.value?.stringValue ??
              rec.eventName ??
              rec.body?.stringValue ??
              "?";
            add(name, rec.attributes);
          }
          for (const m of s.metrics ?? []) {
            const points = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints ?? [];
            add(
              m.name,
              points.flatMap((p) => p.attributes ?? []),
            );
          }
          for (const span of s.spans ?? []) add(span.name, span.attributes);
        }
      }
    }
    summary[signal] = {
      resourceKeys: [...resourceKeys].sort(),
      names: Object.fromEntries(
        Object.entries(names).map(([k, v]) => [k, { count: v.count, keys: [...v.keys].sort() }]),
      ),
    };
  }
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const port = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 4318);
const counts = {};
createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const signal = /\/v1\/(logs|metrics|traces)/.exec(req.url ?? "")?.[1] ?? "other";
    let body = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
    const json = String(req.headers["content-type"] ?? "").includes("json");
    if (json) appendFileSync(join(out, `${signal}.ndjson`), body.toString("utf8").replace(/\n/g, " ") + "\n");
    counts[`${signal}:${json ? "json" : "protobuf"}`] = (counts[`${signal}:${json ? "json" : "protobuf"}`] ?? 0) + 1;
    process.stderr.write(`${JSON.stringify(counts)}\n`);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
}).listen(port, "127.0.0.1", () => process.stderr.write(`listening on 127.0.0.1:${port}\n`));
