ALTER TABLE template_releases
  ADD CONSTRAINT template_releases_publication_scope
  UNIQUE(id,artifact_id,revision_id);

ALTER TABLE revisions
  ADD CONSTRAINT revisions_artifact_id_unique UNIQUE(artifact_id,id);

ALTER TABLE template_releases
  ADD CONSTRAINT template_releases_revision_scope
  FOREIGN KEY(artifact_id,revision_id)
  REFERENCES revisions(artifact_id,id) ON DELETE CASCADE;

CREATE TABLE template_libraries (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  CHECK (
    (state='active' AND archived_at IS NULL)
    OR (state='archived' AND archived_at IS NOT NULL)
  )
);

CREATE TABLE template_library_members (
  library_id uuid NOT NULL REFERENCES template_libraries(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('reader','curator','admin')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY(library_id,account_id),
  CHECK (
    (state='active' AND revoked_at IS NULL)
    OR (state='revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX template_library_members_account
  ON template_library_members(account_id,library_id)
  WHERE state='active';

CREATE TABLE template_library_publications (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL REFERENCES template_libraries(id) ON DELETE CASCADE,
  release_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  publisher_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','withdrawn')),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  withdrawal_reason text CHECK (
    withdrawal_reason IS NULL OR char_length(withdrawal_reason) BETWEEN 1 AND 500
  ),
  UNIQUE(library_id,release_id),
  FOREIGN KEY(release_id,artifact_id,revision_id)
    REFERENCES template_releases(id,artifact_id,revision_id) ON DELETE CASCADE,
  CHECK (
    (state='active' AND withdrawn_at IS NULL AND withdrawal_reason IS NULL)
    OR
    (state='withdrawn' AND withdrawn_at IS NOT NULL AND withdrawal_reason IS NOT NULL)
  )
);

CREATE INDEX template_library_publications_active
  ON template_library_publications(library_id,published_at DESC,id DESC)
  WHERE state='active';

CREATE FUNCTION preserve_template_library_member_revocation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.library_id<>NEW.library_id OR OLD.account_id<>NEW.account_id
     OR OLD.joined_at<>NEW.joined_at
     OR OLD.state='revoked' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'template library membership identity and revocation are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER template_library_member_revocation_immutable
  BEFORE UPDATE ON template_library_members
  FOR EACH ROW EXECUTE FUNCTION preserve_template_library_member_revocation();

CREATE FUNCTION preserve_template_library_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.publisher_id IS NOT NULL AND NEW.publisher_id IS NULL
     AND NEW.id=OLD.id
     AND NEW.library_id=OLD.library_id
     AND NEW.release_id=OLD.release_id
     AND NEW.artifact_id=OLD.artifact_id
     AND NEW.revision_id=OLD.revision_id
     AND NEW.state=OLD.state
     AND NEW.published_at=OLD.published_at
     AND NEW.withdrawn_at IS NOT DISTINCT FROM OLD.withdrawn_at
     AND NEW.withdrawal_reason IS NOT DISTINCT FROM OLD.withdrawal_reason THEN
    RETURN NEW;
  END IF;
  IF NOT (
    OLD.state='active' AND NEW.state='withdrawn'
    AND OLD.id=NEW.id
    AND OLD.library_id=NEW.library_id
    AND OLD.release_id=NEW.release_id
    AND OLD.artifact_id=NEW.artifact_id
    AND OLD.revision_id=NEW.revision_id
    AND NEW.publisher_id IS NOT DISTINCT FROM OLD.publisher_id
    AND OLD.published_at=NEW.published_at
    AND OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL
    AND OLD.withdrawal_reason IS NULL AND NEW.withdrawal_reason IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'template library publication is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER template_library_publication_immutable
  BEFORE UPDATE ON template_library_publications
  FOR EACH ROW EXECUTE FUNCTION preserve_template_library_publication();
