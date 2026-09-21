ALTER TABLE accounts ADD COLUMN deletion_requested_at timestamptz;

ALTER TABLE accounts ADD CONSTRAINT deleting_account_disabled CHECK (
  deletion_requested_at IS NULL OR disabled
);

CREATE FUNCTION preserve_account_deletion_marker() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deletion_requested_at IS NOT NULL AND (
    NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
    OR NOT NEW.disabled
  ) THEN
    RAISE EXCEPTION 'account deletion marker is irreversible';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER account_deletion_marker_immutable
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION preserve_account_deletion_marker();

CREATE TABLE account_deletions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
  tenant_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (
    state IN ('planned','access_revoked_pending_purge','failed','purged')
  ),
  status_capability_hash text NOT NULL UNIQUE
    CHECK (status_capability_hash ~ '^[a-f0-9]{64}$'),
  plan_expires_at timestamptz NOT NULL,
  artifact_count integer NOT NULL CHECK (artifact_count >= 0),
  revision_count integer NOT NULL CHECK (revision_count >= 0),
  source_bytes bigint NOT NULL CHECK (source_bytes >= 0),
  derivative_bytes bigint NOT NULL CHECK (derivative_bytes >= 0),
  policy_version text NOT NULL CHECK (
    char_length(policy_version) BETWEEN 1 AND 80
    AND policy_version ~ '^[A-Za-z0-9._-]+$'
  ),
  purge_max_hours integer NOT NULL CHECK (purge_max_hours BETWEEN 1 AND 8760),
  backup_retention_max_days integer NOT NULL
    CHECK (backup_retention_max_days BETWEEN 0 AND 3650),
  planned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  requested_at timestamptz,
  revoked_at timestamptz,
  working_data_policy_deadline timestamptz,
  backup_retention_policy_deadline timestamptz,
  confirmation_session_hash text,
  purged_at timestamptz,
  retry_at timestamptz,
  error_code text CHECK (
    error_code IS NULL OR error_code IN ('storage','database','ledger','internal')
  ),
  FOREIGN KEY(tenant_id,account_id) REFERENCES tenants(id,owner_id),
  CHECK (
    (state='planned' AND requested_at IS NULL AND revoked_at IS NULL
      AND working_data_policy_deadline IS NULL
      AND backup_retention_policy_deadline IS NULL
      AND confirmation_session_hash IS NULL AND purged_at IS NULL)
    OR
    (state IN ('access_revoked_pending_purge','failed')
      AND requested_at IS NOT NULL AND revoked_at IS NOT NULL
      AND working_data_policy_deadline IS NOT NULL
      AND backup_retention_policy_deadline IS NOT NULL
      AND confirmation_session_hash IS NOT NULL AND purged_at IS NULL)
    OR
    (state='purged' AND requested_at IS NOT NULL AND revoked_at IS NOT NULL
      AND working_data_policy_deadline IS NOT NULL
      AND backup_retention_policy_deadline IS NOT NULL
      AND confirmation_session_hash IS NOT NULL AND purged_at IS NOT NULL)
  )
);

CREATE INDEX account_deletions_state_retry
  ON account_deletions(state,retry_at,id);

CREATE TABLE account_deletion_csrf (
  session_hash text PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
