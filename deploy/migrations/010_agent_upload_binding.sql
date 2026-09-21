ALTER TABLE agent_connections ADD CONSTRAINT agent_connection_identity_unique UNIQUE(id,tenant_id,account_id);
ALTER TABLE uploads ADD COLUMN connection_id uuid;
ALTER TABLE uploads ADD CONSTRAINT upload_agent_identity_fk
  FOREIGN KEY(connection_id,tenant_id,account_id) REFERENCES agent_connections(id,tenant_id,account_id);
CREATE INDEX uploads_agent_status ON uploads(connection_id,id) WHERE connection_id IS NOT NULL;
