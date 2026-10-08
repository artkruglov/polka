// Stage 0: the leaders' questions over the scaled tool-call stream, timed in
// Postgres (EXPLAIN ANALYZE execution time) and ClickHouse (server elapsed),
// three runs each, the median reported. Benchmark containers only.
//   DOCKER_CONFIG=… BENCH_HOST=<the host Q4 counts calls to> node bench.mjs
import { execFileSync } from "node:child_process";

const HOST = process.env.BENCH_HOST ?? "localhost";
const pgTenant = "(select tenant_id from tool_calls limit 1)";
const QUERIES = [
  {
    id: "Q1 топ внешних адресов за 7 дней (вся компания)",
    pg: `select h, count(*) from tool_calls, unnest(hosts) h where at > '2026-09-04' and h not in ('localhost','127.0.0.1') group by h order by 2 desc limit 20`,
    ch: `select h, count() from tool_calls array join hosts as h where at > '2026-09-04' and h not in ('localhost','127.0.0.1') group by h order by 2 desc limit 20`,
  },
  {
    id: "Q2 обращения в сеть по компаниям и дням",
    pg: `select tenant_id, date_trunc('day', at) d, count(*) from tool_calls where network group by 1, 2 order by 1, 2`,
    ch: `select tenant_id, toDate(at) d, count() from tool_calls where network group by 1, 2 order by 1, 2`,
  },
  {
    id: "Q3 активность и объём вывода по проектам (одна компания)",
    pg: `select project_key, count(*), sum(output_bytes) from tool_calls where tenant_id = ${pgTenant} group by 1 order by 2 desc limit 20`,
    ch: `select project_key, count(), sum(output_bytes) from tool_calls where tenant_id = (select tenant_id from tool_calls limit 1) group by 1 order by 2 desc limit 20`,
  },
  {
    id: "Q4 доля ошибок по MCP-серверам",
    pg: `select mcp_server, count(*), avg((status = 'error')::int) from tool_calls where mcp_server is not null group by 1 order by 2 desc`,
    ch: `select mcp_server, count(), avg(status = 'error') from tool_calls where mcp_server != '' group by 1 order by 2 desc`,
  },
  {
    id: "Q5 рискованные команды по людям",
    pg: `select account_id, count(*) from tool_calls where argv0 in ('kubectl','terraform','helm') or template like 'rm -rf%' or template like 'git push --force%' or template like 'git push -f%' group by 1 order by 2 desc limit 20`,
    ch: `select account_id, count() from tool_calls where argv0 in ('kubectl','terraform','helm') or startsWith(template, 'rm -rf') or startsWith(template, 'git push --force') or startsWith(template, 'git push -f') group by 1 order by 2 desc limit 20`,
  },
  {
    id: "Q6 кто обращался к адресу X",
    pg: `select account_id, count(distinct session_id), count(*) from tool_calls where hosts @> array['${HOST}'] group by 1 order by 3 desc limit 50`,
    ch: `select account_id, uniqExact(session_id), count() from tool_calls where has(hosts, '${HOST}') group by 1 order by 3 desc limit 50`,
  },
  {
    id: "Q7 активные проекты за 7 дней",
    pg: `select project_key, count(distinct account_id), count(distinct session_id) from tool_calls where at > '2026-09-04' group by 1 order by 3 desc limit 30`,
    ch: `select project_key, uniqExact(account_id), uniqExact(session_id) from tool_calls where at > '2026-09-04' group by 1 order by 3 desc limit 30`,
  },
  {
    id: "Q8 тренд по видам инструментов по дням",
    pg: `select date_trunc('day', at), kind, count(*) from tool_calls group by 1, 2 order by 1, 2`,
    ch: `select toDate(at), kind, count() from tool_calls group by 1, 2 order by 1, 2`,
  },
  {
    id: "Q9 разбор одной сессии",
    pg: `select seq, at, tool, status, template from tool_calls where session_id = (select session_id from tool_calls where at > '2026-09-05' limit 1) order by seq`,
    ch: `select seq, at, tool, status, template from tool_calls where session_id = (select session_id from tool_calls where at > '2026-09-05' limit 1) order by seq`,
  },
  {
    id: "Q10 сводка одного человека по дням",
    pg: `select date_trunc('day', at), count(*), sum((status='error')::int), sum(network::int) from tool_calls where account_id = (select account_id from tool_calls limit 1) group by 1 order by 1`,
    ch: `select toDate(at), count(), countIf(status='error'), sum(network) from tool_calls where account_id = (select account_id from tool_calls limit 1) group by 1 order by 1`,
  },
];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function pg(sql) {
  const out = execFileSync("docker", ["exec", "bench-pg", "psql", "-U", "postgres", "-At", "-c", `EXPLAIN (ANALYZE, FORMAT TEXT) ${sql}`], { encoding: "utf8", maxBuffer: 64 << 20 });
  return Number(/Execution Time: ([\d.]+) ms/.exec(out)[1]);
}
function ch(sql) {
  const out = execFileSync("docker", ["exec", "bench-ch", "clickhouse-client", "--password", "bench", "--time", "--format", "Null", "--query", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  return out;
}
function chTime(sql) {
  const result = execFileSync("sh", ["-c", `docker exec bench-ch clickhouse-client --password bench --time --format Null --query "${sql.replace(/"/g, '\\"')}" 2>&1`], { encoding: "utf8" });
  return Number(result.trim().split("\n").pop()) * 1000;
}
void ch;
const rows = [];
for (const q of QUERIES) {
  const p = [pg(q.pg), pg(q.pg), pg(q.pg)];
  const c = [chTime(q.ch), chTime(q.ch), chTime(q.ch)];
  rows.push({ query: q.id, postgresMs: Math.round(median(p)), clickhouseMs: Math.round(median(c)) });
  console.error(`${q.id}: pg ${Math.round(median(p))} ms, ch ${Math.round(median(c))} ms`);
}
console.log(JSON.stringify(rows, null, 2));
