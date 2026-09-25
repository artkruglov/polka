-- Department shelves, stage 3 (docs/specs/TEAM_SHELVES.md): an agent is
-- connected to one shelf the account belongs to, its own or a department's.
--
-- agent_connections, oauth_authorizations, url_import_jobs
--   (tenant_id, account_id) referred to tenants(id, owner_id): only one's own
--   shelf. Now they refer to tenant_members(tenant_id, account_id): a shelf
--   the account is (or was) a member of. A personal shelf's owner is its
--   member, so every existing row still has its target.
-- tenant_members
--   a member who leaves or is removed loses the agents connected to that
--   shelf for good: re-adding the member does not bring them back.
ALTER TABLE agent_connections
  DROP CONSTRAINT agent_connections_tenant_id_account_id_fkey,
  ADD CONSTRAINT agent_connections_member_fkey
    FOREIGN KEY (tenant_id, account_id) REFERENCES tenant_members(tenant_id, account_id);

ALTER TABLE oauth_authorizations
  DROP CONSTRAINT oauth_authorizations_tenant_id_account_id_fkey,
  ADD CONSTRAINT oauth_authorizations_member_fkey
    FOREIGN KEY (tenant_id, account_id) REFERENCES tenant_members(tenant_id, account_id);

ALTER TABLE url_import_jobs
  DROP CONSTRAINT url_import_jobs_tenant_id_account_id_fkey,
  ADD CONSTRAINT url_import_jobs_member_fkey
    FOREIGN KEY (tenant_id, account_id) REFERENCES tenant_members(tenant_id, account_id)
    ON DELETE CASCADE;

CREATE FUNCTION revoke_agents_on_leaving() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agent_connections SET revoked_at = clock_timestamp()
  WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id AND revoked_at IS NULL;
  UPDATE oauth_refresh_tokens SET revoked_at = clock_timestamp()
  WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id AND revoked_at IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER revoke_agents_on_leaving
  AFTER UPDATE OF state ON tenant_members
  FOR EACH ROW
  WHEN (NEW.state = 'revoked' AND OLD.state = 'active')
  EXECUTE FUNCTION revoke_agents_on_leaving();
