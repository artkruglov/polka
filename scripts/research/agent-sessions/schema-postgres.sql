-- Stage 0 benchmark schema (docs/research/agent-telemetry-storage.md): one
-- wide tool-call table; indexes are built after the load.
CREATE TABLE tool_calls (
  tenant_id uuid NOT NULL, account_id uuid NOT NULL, session_id uuid NOT NULL, seq int NOT NULL,
  at timestamptz NOT NULL, tool text NOT NULL, kind text NOT NULL, mcp_server text, status text NOT NULL,
  duration_ms int, exit_code int, input_bytes int, output_bytes int, argv0 text, template text,
  hosts text[] NOT NULL, network boolean NOT NULL, project_key text NOT NULL
);
-- After COPY:
-- CREATE INDEX ON tool_calls USING brin(at); CREATE INDEX ON tool_calls(tenant_id, at);
-- CREATE INDEX ON tool_calls(account_id, at); CREATE INDEX ON tool_calls(session_id);
-- CREATE INDEX ON tool_calls USING gin(hosts); ANALYZE tool_calls;
