ALTER TABLE tenants ADD CONSTRAINT tenant_id_owner_unique UNIQUE(id,owner_id);

CREATE TABLE agent_connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 5
    AND scopes <@ ARRAY['context','read','capture','revise','share']::text[]
  ),
  audience text NOT NULL CHECK (char_length(audience) BETWEEN 1 AND 2048),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,account_id) REFERENCES tenants(id,owner_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (last_seen_at IS NULL OR last_seen_at >= created_at)
);
CREATE INDEX agent_connections_owner_list
  ON agent_connections(tenant_id,created_at DESC,id DESC);
CREATE INDEX agent_connections_active
  ON agent_connections(tenant_id,expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE agent_connection_csrf (
  session_hash text PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX agent_connection_csrf_expiry ON agent_connection_csrf(expires_at);
