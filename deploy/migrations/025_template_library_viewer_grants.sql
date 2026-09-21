ALTER TABLE sessions
  ADD CONSTRAINT sessions_hash_account_unique UNIQUE(hash,account_id);

ALTER TABLE template_library_publications
  ADD CONSTRAINT template_library_publication_viewer_scope
  UNIQUE(id,library_id,artifact_id,revision_id);

CREATE TABLE template_library_viewer_grants (
  hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  session_hash text NOT NULL,
  library_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  member_account_id uuid NOT NULL,
  membership_joined_at timestamptz NOT NULL,
  derivative_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(session_hash,member_account_id)
    REFERENCES sessions(hash,account_id) ON DELETE CASCADE,
  FOREIGN KEY(library_id,member_account_id,membership_joined_at)
    REFERENCES template_library_members(library_id,account_id,joined_at)
    ON DELETE CASCADE,
  FOREIGN KEY(publication_id,library_id,artifact_id,revision_id)
    REFERENCES template_library_publications(id,library_id,artifact_id,revision_id)
    ON DELETE CASCADE,
  FOREIGN KEY(derivative_id,revision_id)
    REFERENCES revision_derivatives(id,revision_id) ON DELETE CASCADE,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '60 seconds')
);

CREATE INDEX template_library_viewer_grants_expiry
  ON template_library_viewer_grants(expires_at);
