ALTER TABLE uploads ADD COLUMN kind text NOT NULL DEFAULT 'single'
  CHECK (kind IN ('single','bundle'));
CREATE INDEX pending_upload_kind ON uploads(tenant_id,kind,id)
  WHERE receipt IS NULL AND NOT aborted;

CREATE TABLE upload_files (
  upload_id uuid NOT NULL REFERENCES uploads(id),
  file_index smallint NOT NULL CHECK (file_index >= 0 AND file_index < 64),
  object_key text NOT NULL UNIQUE,
  object_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(upload_id,file_index)
);

ALTER TABLE revisions ADD COLUMN storage_kind text NOT NULL DEFAULT 'single'
  CHECK (storage_kind IN ('single','bundle'));
ALTER TABLE revisions ADD COLUMN total_size integer;
UPDATE revisions SET total_size=size;
ALTER TABLE revisions ALTER COLUMN total_size SET NOT NULL;
ALTER TABLE revisions ADD CONSTRAINT revision_total_size CHECK (
  total_size >= size AND total_size <= 5242880
);
ALTER TABLE revisions ADD CONSTRAINT bundle_revision_shape CHECK (
  storage_kind <> 'bundle'
  OR (
    mime='text/html'
    AND html_profile='unsupported'
    AND manifest IS NOT NULL
    AND manifest_sha256 IS NOT NULL
  )
);

CREATE TABLE revision_files (
  revision_id uuid NOT NULL REFERENCES revisions(id),
  file_index smallint NOT NULL CHECK (file_index >= 0 AND file_index < 64),
  path text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL UNIQUE,
  object_version text NOT NULL,
  PRIMARY KEY(revision_id,file_index),
  UNIQUE(revision_id,path)
);
CREATE INDEX revision_files_revision ON revision_files(revision_id,file_index);
