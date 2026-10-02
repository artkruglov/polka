-- How often agents read a shelf through the API and MCP, for the metric
-- «share of machine reads» (docs/specs/AGENT_ACCESS_AND_MEMORY.md, «Метрики»).
--
-- One row per shelf, UTC day and kind of token (a person's or a service
-- account's): a count, nothing about which agent, which work or what was
-- read. It goes with the shelf (ON DELETE CASCADE).
CREATE TABLE agent_read_days (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day date NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('human','service')),
  reads integer NOT NULL CHECK (reads > 0),
  PRIMARY KEY (tenant_id, day, principal_type)
);
