-- Department shelves (docs/specs/TEAM_SHELVES.md), stage 1: the model.
--
-- tenants          + kind: 'personal' (one owner, as before) or 'team' (members,
--                    no owner: owner_id is NULL, so every lookup of a shelf by
--                    its owner still finds exactly the personal one).
--                  + name (a team shelf's), state (active|archived),
--                    created_by, created_at.
-- tenant_members   who may open a shelf and with which role. Every personal
--                  shelf has its owner here as 'owner' (backfilled below and
--                  kept by a trigger for new ones); a team shelf has readers,
--                  authors, curators and admins. A member leaves by
--                  state='revoked'; the row stays for the journal.
-- tenant_member_events
--                  append-only journal of a team shelf: who created it, who was
--                  added, changed or removed, by whom.
-- accounts         + company_admin: may create department shelves (set by the
--                    operator: npm run company:admin).
ALTER TABLE tenants
  ADD COLUMN kind text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','team')),
  ADD COLUMN name text CHECK (name IS NULL OR char_length(btrim(name)) BETWEEN 1 AND 80),
  ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
  ADD COLUMN created_by uuid REFERENCES accounts(id),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ALTER COLUMN owner_id DROP NOT NULL,
  ADD CONSTRAINT tenants_kind_owner CHECK ((kind = 'personal') = (owner_id IS NOT NULL)),
  ADD CONSTRAINT tenants_kind_name CHECK ((kind = 'team') = (name IS NOT NULL));

ALTER TABLE accounts ADD COLUMN company_admin boolean NOT NULL DEFAULT false;

CREATE TABLE tenant_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','curator','author','reader')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  invited_by uuid REFERENCES accounts(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, account_id),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX tenant_members_account ON tenant_members (account_id) WHERE state = 'active';

-- 'owner' belongs to a personal shelf's owner and nobody else.
CREATE FUNCTION tenant_member_owner_matches() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shelf record;
BEGIN
  SELECT kind, owner_id INTO shelf FROM tenants WHERE id = NEW.tenant_id;
  IF (NEW.role = 'owner') <> (shelf.kind = 'personal' AND shelf.owner_id = NEW.account_id) THEN
    RAISE EXCEPTION 'owner role belongs to the owner of a personal shelf only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_member_owner_matches
  BEFORE INSERT OR UPDATE ON tenant_members
  FOR EACH ROW EXECUTE FUNCTION tenant_member_owner_matches();

-- A new personal shelf gets its owner as a member, whichever path made it.
CREATE FUNCTION tenant_owner_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'personal' THEN
    INSERT INTO tenant_members (tenant_id, account_id, role)
    VALUES (NEW.id, NEW.owner_id, 'owner')
    ON CONFLICT (tenant_id, account_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_owner_membership
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenant_owner_membership();

INSERT INTO tenant_members (tenant_id, account_id, role)
SELECT id, owner_id, 'owner' FROM tenants WHERE kind = 'personal'
ON CONFLICT (tenant_id, account_id) DO NOTHING;

CREATE TABLE tenant_member_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'shelf_created','shelf_renamed','shelf_archived',
    'member_added','member_role_changed','member_revoked')),
  target_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  old_role text,
  new_role text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_member_events_shelf ON tenant_member_events (tenant_id, id DESC);
