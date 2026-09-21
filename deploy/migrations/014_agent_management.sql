ALTER TABLE agent_connections
  DROP CONSTRAINT agent_connections_scopes_check,
  ADD CONSTRAINT agent_connections_scopes_check CHECK (
    cardinality(scopes) BETWEEN 1 AND 6
    AND scopes <@ ARRAY['context','read','capture','revise','share','manage']::text[]
  );

ALTER TABLE agent_operations
  DROP CONSTRAINT agent_operations_operation_check,
  ADD CONSTRAINT agent_operations_operation_check
    CHECK(operation IN ('share','metadata'));
