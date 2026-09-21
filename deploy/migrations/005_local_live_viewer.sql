CREATE TABLE viewer_grants (
 hash text PRIMARY KEY,
 revision_id uuid NOT NULL REFERENCES revisions,
 owner_session_hash text REFERENCES sessions(hash) ON DELETE CASCADE,
 share_id uuid REFERENCES shares,
 source_grant_hash text REFERENCES grants(hash) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (
   (owner_session_hash IS NOT NULL AND share_id IS NULL AND source_grant_hash IS NULL)
   OR
   (owner_session_hash IS NULL AND share_id IS NOT NULL AND source_grant_hash IS NOT NULL)
 ),
 CHECK (expires_at > created_at AND expires_at <= created_at + interval '60 seconds')
);
CREATE INDEX viewer_grants_expiry ON viewer_grants(expires_at);
