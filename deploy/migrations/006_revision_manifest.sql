ALTER TABLE revisions ADD COLUMN manifest jsonb;
ALTER TABLE revisions ADD COLUMN manifest_sha256 text;
ALTER TABLE revisions ADD CONSTRAINT revision_manifest_pair CHECK (
  (manifest IS NULL AND manifest_sha256 IS NULL)
  OR
  (
    manifest IS NOT NULL
    AND manifest_sha256 IS NOT NULL
    AND manifest_sha256 ~ '^[a-f0-9]{64}$'
  )
);
