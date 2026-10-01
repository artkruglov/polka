-- Service accounts: an agent that runs without a person at the keyboard (cron,
-- CI) on one shelf, with a named person responsible for it
-- (docs/specs/DATA_MODELS.md §3, §4).
--
-- service_principals: one per shelf and name. Its tokens are agent_connections
-- rows with principal_type 'service'; their account_id is the responsible
-- person, who is the actor the shelf's roles are checked against. When that
-- person leaves the shelf the principal is frozen (the existing membership
-- check already stops its tokens); an admin names another responsible person
-- to bring it back. The old connections are not revoked by the departure.
-- Task tokens: short children (parent_id) of a service token, now up to 60
-- minutes (was 30, for project uploads; project-upload.ts keeps its own 30).
CREATE TABLE service_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  responsible_account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','disabled')),
  frozen_at timestamptz NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz NULL
);
CREATE UNIQUE INDEX service_principals_name ON service_principals (tenant_id, lower(name))
  WHERE status <> 'disabled';

ALTER TABLE agent_connections
  ADD COLUMN principal_type text NOT NULL DEFAULT 'human' CHECK (principal_type IN ('human','service')),
  ADD COLUMN service_principal_id uuid NULL REFERENCES service_principals(id) ON DELETE CASCADE,
  ADD CONSTRAINT agent_connections_principal_shape CHECK (
    (principal_type = 'human' AND service_principal_id IS NULL)
    OR (principal_type = 'service' AND service_principal_id IS NOT NULL AND oauth_client_id IS NULL)
  ),
  DROP CONSTRAINT agent_connections_child_shape,
  ADD CONSTRAINT agent_connections_child_shape CHECK (
    parent_id IS NULL OR (oauth_client_id IS NULL AND expires_at <= created_at + interval '60 minutes')
  );
CREATE INDEX agent_connections_service ON agent_connections (service_principal_id)
  WHERE service_principal_id IS NOT NULL;

-- Leaving the shelf ends a person's own agents for good; a service account
-- they answered for is frozen instead, and keeps its tokens for the next
-- responsible person.
CREATE OR REPLACE FUNCTION revoke_agents_on_leaving() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agent_connections SET revoked_at = clock_timestamp()
  WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id AND revoked_at IS NULL
    AND principal_type = 'human';
  UPDATE oauth_refresh_tokens SET revoked_at = clock_timestamp()
  WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id AND revoked_at IS NULL;
  UPDATE service_principals SET status = 'frozen', frozen_at = clock_timestamp()
  WHERE tenant_id = NEW.tenant_id AND responsible_account_id = NEW.account_id AND status = 'active';
  RETURN NEW;
END $$;
