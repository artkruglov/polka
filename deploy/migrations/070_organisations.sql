-- Organisations for department shelves on a shared cloud
-- (docs/specs/TEAM_SHELVES.md, «Организации в облаке»). With
-- TEAM_SHELVES_SCOPE=organisation a company admin administers the shelves of
-- one organisation only, and a shelf admin adds directly only people of the
-- shelf's organisation. With the default scope (installation) these columns
-- are ignored: the installation is one company, as before.
--
-- organisations           a company on the installation; created by the
--                         operator (npm run admin -- company org).
-- organisation_domains    its own mail domains: a verified address there
--                         makes an account a person of the organisation.
-- tenants                 + organisation_id: the organisation of a department
--                         shelf (never of a personal one).
-- accounts                + company_organisation_id: the organisation a
--                         company admin administers.
-- tenant_member_events    + action shelf_organisation_changed.
--
-- Organisation names are unique by lower(name), which follows the database's
-- ctype (en_US.utf8 on polochka.app: Cyrillic folds too).
--
-- Erasure: an organisation and its domains are not personal data and stay.
-- The rename that ends an account's erasure (030, also replayed by the
-- restore reconcile) clears the account's company admin role, so an erased
-- account restored from an older backup never administers anything.
CREATE TABLE organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organisations_name ON organisations (lower(name));

CREATE TABLE organisation_domains (
  domain text PRIMARY KEY CHECK (domain = lower(domain) AND char_length(domain) BETWEEN 3 AND 253),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organisation_domains_organisation ON organisation_domains (organisation_id);

ALTER TABLE tenants
  ADD COLUMN organisation_id uuid NULL REFERENCES organisations(id),
  ADD CONSTRAINT tenants_organisation_team CHECK (organisation_id IS NULL OR kind = 'team');
CREATE INDEX tenants_organisation ON tenants (organisation_id) WHERE organisation_id IS NOT NULL;

-- The operator attaching a shelf to an organisation, or moving it to another
-- one, is recorded in the shelf's journal (no actor: the operator has no
-- account here).
ALTER TABLE tenant_member_events
  DROP CONSTRAINT tenant_member_events_action_check,
  ADD CONSTRAINT tenant_member_events_action_check CHECK (action IN (
    'shelf_created','shelf_renamed','shelf_archived',
    'member_added','member_role_changed','member_revoked',
    'invitation_created','invitation_revoked','invitation_accepted',
    'shelf_organisation_changed'));

ALTER TABLE accounts
  ADD COLUMN company_organisation_id uuid NULL REFERENCES organisations(id),
  ADD CONSTRAINT accounts_company_organisation CHECK (company_organisation_id IS NULL OR company_admin);

CREATE FUNCTION erase_account_company_admin() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  NEW.company_admin := false;
  NEW.company_organisation_id := NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION erase_account_company_admin() FROM PUBLIC;

CREATE TRIGGER erase_account_company_admin
  BEFORE UPDATE OF name ON accounts
  FOR EACH ROW
  WHEN (NEW.name = 'deleted-' || NEW.id::text AND OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION erase_account_company_admin();
