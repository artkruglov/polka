-- Invitation acceptance can create a new membership epoch after an earlier
-- membership was revoked. Revoked rows remain immutable audit history.
ALTER TABLE template_library_members
  DROP CONSTRAINT template_library_members_pkey;

ALTER TABLE template_library_members
  ADD PRIMARY KEY(library_id,account_id,joined_at);

CREATE UNIQUE INDEX template_library_members_one_active
  ON template_library_members(library_id,account_id)
  WHERE state='active' AND revoked_at IS NULL;

CREATE TABLE template_library_invitations (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL REFERENCES template_libraries(id) ON DELETE CASCADE,
  email text,
  role text NOT NULL CHECK (role IN ('reader','curator','admin')),
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','accepted','revoked','redacted')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  accepted_membership_joined_at timestamptz,
  revoked_at timestamptz,
  redacted_at timestamptz,
  FOREIGN KEY(library_id,accepted_by,accepted_membership_joined_at)
    REFERENCES template_library_members(library_id,account_id,joined_at),
  CHECK (email IS NULL OR (email=lower(btrim(email)) AND char_length(email)<=254)),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '7 days'),
  CHECK (
    (state='pending' AND email IS NOT NULL AND token_hash IS NOT NULL
      AND invited_by IS NOT NULL AND accepted_at IS NULL AND accepted_by IS NULL
      AND accepted_membership_joined_at IS NULL AND revoked_at IS NULL
      AND redacted_at IS NULL)
    OR
    (state='accepted' AND email IS NOT NULL AND token_hash IS NOT NULL
      AND accepted_at IS NOT NULL AND accepted_by IS NOT NULL
      AND accepted_membership_joined_at IS NOT NULL AND revoked_at IS NULL
      AND redacted_at IS NULL)
    OR
    (state='revoked' AND email IS NOT NULL AND accepted_at IS NULL
      AND accepted_by IS NULL AND accepted_membership_joined_at IS NULL
      AND revoked_at IS NOT NULL AND redacted_at IS NULL)
    OR
    (state='redacted' AND email IS NULL AND token_hash IS NULL
      AND accepted_by IS NULL AND accepted_membership_joined_at IS NULL
      AND redacted_at IS NOT NULL)
  )
);

CREATE INDEX template_library_invitations_library
  ON template_library_invitations(library_id,created_at DESC,id DESC);

-- Terminal account erasure deletes memberships before anonymizing the retained
-- account row. Redact the recipient link before that delete reaches the FK.
CREATE FUNCTION redact_template_library_invitation_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE template_library_invitations
     SET state='redacted',email=NULL,token_hash=NULL,accepted_by=NULL,
         accepted_membership_joined_at=NULL,redacted_at=clock_timestamp()
   WHERE library_id=OLD.library_id AND accepted_by=OLD.account_id
     AND accepted_membership_joined_at=OLD.joined_at;
  RETURN OLD;
END $$;

CREATE TRIGGER template_library_invitation_membership_erasure
  BEFORE DELETE ON template_library_members
  FOR EACH ROW EXECUTE FUNCTION redact_template_library_invitation_membership();

-- The terminal purge retains an anonymized account tombstone. Clear pending,
-- revoked, and accepted invitation recipient identity by the original email;
-- outstanding invitations from a purged administrator become unusable too.
CREATE FUNCTION redact_template_library_invitation_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.email IS NOT NULL AND NEW.email IS NULL THEN
    UPDATE template_library_invitations
       SET state='redacted',email=NULL,token_hash=NULL,accepted_by=NULL,
           accepted_membership_joined_at=NULL,redacted_at=clock_timestamp()
     WHERE email=OLD.email OR accepted_by=OLD.id;
    UPDATE template_library_invitations
       SET invited_by=NULL,
           state=CASE WHEN state='pending' THEN 'revoked' ELSE state END,
           token_hash=CASE WHEN state='pending' THEN NULL ELSE token_hash END,
           revoked_at=CASE WHEN state='pending' THEN clock_timestamp() ELSE revoked_at END
     WHERE invited_by=OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER template_library_invitation_account_erasure
  BEFORE UPDATE OF email ON accounts
  FOR EACH ROW EXECUTE FUNCTION redact_template_library_invitation_account();
