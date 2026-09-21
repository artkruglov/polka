ALTER TABLE audit_outbox ADD COLUMN actor_type text NOT NULL DEFAULT 'human' CHECK(actor_type IN ('human','agent'));
ALTER TABLE audit_outbox ADD COLUMN connection_id uuid;
ALTER TABLE audit_outbox ADD CONSTRAINT audit_agent_identity_fk
  FOREIGN KEY(connection_id,tenant_id,actor_id) REFERENCES agent_connections(id,tenant_id,account_id);
ALTER TABLE audit_outbox ADD CONSTRAINT audit_agent_shape CHECK((actor_type='human' AND connection_id IS NULL) OR (actor_type='agent' AND connection_id IS NOT NULL));
