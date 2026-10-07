# Agent sessions research (stage 0)

Scripts behind [docs/research/agent-telemetry-storage.md](../../../docs/research/agent-telemetry-storage.md). They read local Claude Code and Codex sessions, redact secrets on the machine and keep only facts; write their output outside the repository (the session data is personal).

| File | What |
|---|---|
| `redact.mjs` | Secret rules, keyed fingerprints, masked samples for tuning |
| `normalize.mjs` | Claude Code and Codex transcripts → session index (facts, tool calls, commands, hosts, tokens, secrets report) |
| `build-dataset.mjs` | All local sessions → NDJSON tables, in parallel |
| `stats.mjs` | The dataset's shape |
| `scale.mjs` | Company-sized stream from real sessions (deterministic) for Postgres or ClickHouse |
| `schema-postgres.sql`, `schema-clickhouse.sql` | Benchmark schemas |
| `bench.mjs` | The leaders' ten questions, timed in both |
