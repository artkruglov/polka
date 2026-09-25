-- Department shelves (docs/specs/TEAM_SHELVES.md): invariants kept by the
-- database, found in review.
--
-- tenant_members  a personal shelf has its owner and nobody else.
-- accounts        a deletion request (also set by account merge and erasure
--                 restore) revokes the account's department memberships; the
--                 shelves and their works stay with the company.
-- tenants         created_at of shelves that existed before 042 is their
--                 owner's, not the migration's.
CREATE OR REPLACE FUNCTION tenant_member_owner_matches() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shelf record;
BEGIN
  SELECT kind, owner_id INTO shelf FROM tenants WHERE id = NEW.tenant_id;
  IF (NEW.role = 'owner') <> (shelf.kind = 'personal' AND shelf.owner_id = NEW.account_id) THEN
    RAISE EXCEPTION 'owner role belongs to the owner of a personal shelf only';
  END IF;
  IF shelf.kind = 'personal' AND NEW.account_id <> shelf.owner_id THEN
    RAISE EXCEPTION 'a personal shelf has no members but its owner';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION revoke_memberships_on_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tenant_members SET state = 'revoked', revoked_at = clock_timestamp()
  WHERE account_id = NEW.id AND role <> 'owner' AND state = 'active';
  RETURN NEW;
END $$;
CREATE TRIGGER revoke_memberships_on_deletion
  AFTER UPDATE OF deletion_requested_at ON accounts
  FOR EACH ROW
  WHEN (NEW.deletion_requested_at IS NOT NULL AND OLD.deletion_requested_at IS NULL)
  EXECUTE FUNCTION revoke_memberships_on_deletion();

UPDATE tenants t SET created_at = a.created_at
FROM accounts a
WHERE t.owner_id = a.id AND a.created_at IS NOT NULL AND t.created_at > a.created_at;
