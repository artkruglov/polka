-- Invitation links to a department shelf (docs/specs/TEAM_SHELVES.md,
-- «Приглашение ссылкой»). An admin or a curator of the shelf issues a link
-- with a role below admin, an expiry of at most 7 days and a number of uses;
-- whoever opens it signed in becomes a member with that role. Only the hash
-- of the link's secret is kept; a revoked link forgets it.
--
-- tenant_invitations       one row per link: role, expiry, uses, who issued it.
-- tenant_member_events     + invitation_created, invitation_revoked,
--                            invitation_accepted and the link they concern.
CREATE TABLE tenant_invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('reader','author','curator')),
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 50),
  uses integer NOT NULL DEFAULT 0 CHECK (uses BETWEEN 0 AND max_uses),
  invited_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '7 days'),
  CHECK ((state='revoked') = (revoked_at IS NOT NULL)),
  CHECK (state='revoked' OR token_hash IS NOT NULL),
  CHECK (state='active' OR token_hash IS NULL)
);

CREATE INDEX tenant_invitations_shelf
  ON tenant_invitations(tenant_id,created_at DESC,id DESC);

ALTER TABLE tenant_member_events
  DROP CONSTRAINT tenant_member_events_action_check,
  ADD CONSTRAINT tenant_member_events_action_check CHECK (action IN (
    'shelf_created','shelf_renamed','shelf_archived',
    'member_added','member_role_changed','member_revoked',
    'invitation_created','invitation_revoked','invitation_accepted')),
  ADD COLUMN invitation_id uuid REFERENCES tenant_invitations(id) ON DELETE SET NULL;
