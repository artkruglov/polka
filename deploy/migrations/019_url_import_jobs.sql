CREATE TABLE url_import_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  connection_id uuid,
  idempotency_key uuid NOT NULL,
  request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','fetching','prepared','saving','previewing','ready','partial','failed','cancelled')),
  prepared jsonb CHECK(prepared IS NULL OR (jsonb_typeof(prepared)='object' AND octet_length(prepared::text)<=8388608)),
  receipt jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(warnings)='array'),
  error_code text,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',
  FOREIGN KEY(tenant_id,account_id) REFERENCES tenants(id,owner_id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id,tenant_id,account_id) REFERENCES agent_connections(id,tenant_id,account_id) ON DELETE CASCADE,
  UNIQUE(tenant_id,idempotency_key),
  CHECK ((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK (state NOT IN ('previewing','ready','partial') OR receipt IS NOT NULL)
);
CREATE INDEX url_import_jobs_pending ON url_import_jobs(created_at,id)
  WHERE state IN ('queued','fetching','prepared','saving','previewing');
CREATE INDEX url_import_jobs_owner ON url_import_jobs(tenant_id,account_id,created_at DESC);
