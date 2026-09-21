CREATE TABLE agent_operations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN ('share')),
  idempotency_key uuid NOT NULL,
  request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(connection_id,tenant_id,account_id)
    REFERENCES agent_connections(id,tenant_id,account_id),
  UNIQUE(tenant_id,operation,idempotency_key)
);
CREATE INDEX agent_operations_connection
  ON agent_operations(connection_id,created_at DESC,id DESC);
