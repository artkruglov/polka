-- Stage 0 benchmark schema (docs/research/agent-telemetry-storage.md).
CREATE TABLE tool_calls (
  tenant_id UUID, account_id UUID, session_id UUID, seq UInt32, at DateTime64(3, 'UTC'),
  tool LowCardinality(String), kind LowCardinality(String), mcp_server LowCardinality(String), status LowCardinality(String),
  duration_ms Int64, exit_code Int32, input_bytes UInt32, output_bytes UInt32, argv0 LowCardinality(String), template String,
  hosts Array(LowCardinality(String)), network UInt8, project_key LowCardinality(String)
) ENGINE = MergeTree PARTITION BY toYYYYMM(at) ORDER BY (tenant_id, toDate(at), account_id, session_id, seq);
