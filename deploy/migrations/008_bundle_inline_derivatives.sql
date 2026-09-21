ALTER TABLE tenants
  ADD COLUMN derivative_used_bytes bigint NOT NULL DEFAULT 0 CHECK (derivative_used_bytes >= 0),
  ADD COLUMN derivative_quota_bytes bigint NOT NULL DEFAULT 33554432 CHECK (derivative_quota_bytes >= 0);

ALTER TABLE revisions ADD CONSTRAINT revision_id_tenant_unique UNIQUE(id,tenant_id);

CREATE TABLE revision_derivatives (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants,
  revision_id uuid NOT NULL,
  source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  builder_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','ready','unsupported','failed')),
  attempt_id uuid,
  attempt_expires_at timestamptz,
  runtime_profile text,
  size integer CHECK (size >= 0 AND size <= 8388608),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  object_key text UNIQUE,
  object_version text,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 300),
  error_path text CHECK (error_path IS NULL OR char_length(error_path) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(revision_id,source_manifest_sha256,builder_version),
  UNIQUE(id,revision_id),
  FOREIGN KEY(revision_id,tenant_id) REFERENCES revisions(id,tenant_id),
  CHECK (
    (state='pending' AND attempt_id IS NOT NULL AND attempt_expires_at IS NOT NULL
      AND runtime_profile IS NULL AND size IS NULL AND sha256 IS NULL
      AND object_key IS NULL AND object_version IS NULL)
    OR
    (state='ready' AND attempt_id IS NOT NULL AND attempt_expires_at IS NULL
      AND runtime_profile IS NOT NULL AND size IS NOT NULL AND sha256 IS NOT NULL
      AND object_key IS NOT NULL AND object_version IS NOT NULL
      AND reason IS NULL AND error_path IS NULL)
    OR
    (state IN ('unsupported','failed') AND attempt_expires_at IS NULL
      AND runtime_profile IS NULL AND size IS NULL AND sha256 IS NULL
      AND object_key IS NULL AND object_version IS NULL)
  )
);
CREATE INDEX revision_derivatives_tenant_state
  ON revision_derivatives(tenant_id,state,attempt_expires_at);

CREATE FUNCTION preserve_ready_revision_derivative() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='ready' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ready revision derivative is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revision_derivative_ready_immutable
  BEFORE UPDATE ON revision_derivatives
  FOR EACH ROW EXECUTE FUNCTION preserve_ready_revision_derivative();

ALTER TABLE shares ADD COLUMN derivative_id uuid;
ALTER TABLE shares ADD CONSTRAINT share_derivative_revision
  FOREIGN KEY(derivative_id,revision_id) REFERENCES revision_derivatives(id,revision_id);

ALTER TABLE grants ADD COLUMN derivative_id uuid;
ALTER TABLE grants ADD CONSTRAINT grant_derivative_revision
  FOREIGN KEY(derivative_id,revision_id) REFERENCES revision_derivatives(id,revision_id);

ALTER TABLE viewer_grants ADD COLUMN derivative_id uuid;
ALTER TABLE viewer_grants ADD CONSTRAINT viewer_grant_derivative_revision
  FOREIGN KEY(derivative_id,revision_id) REFERENCES revision_derivatives(id,revision_id);
