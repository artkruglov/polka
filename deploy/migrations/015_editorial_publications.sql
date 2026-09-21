CREATE TABLE editorial_publications (
  id uuid PRIMARY KEY,
  slug text NOT NULL CHECK (
    char_length(slug) BETWEEN 1 AND 80
    AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  tenant_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  share_id uuid NOT NULL UNIQUE REFERENCES shares(id),
  derivative_id uuid,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  derivative_sha256 text CHECK (derivative_sha256 ~ '^[a-f0-9]{64}$'),
  builder_version text,
  runtime_profile text,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata)='object'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  FOREIGN KEY(tenant_id,artifact_id,revision_id)
    REFERENCES revisions(tenant_id,artifact_id,id),
  FOREIGN KEY(derivative_id,revision_id)
    REFERENCES revision_derivatives(id,revision_id),
  CHECK (
    (derivative_id IS NULL AND derivative_sha256 IS NULL
      AND builder_version IS NULL AND runtime_profile IS NULL)
    OR
    (derivative_id IS NOT NULL AND derivative_sha256 IS NOT NULL
      AND builder_version IS NOT NULL AND runtime_profile IS NOT NULL)
  )
);

CREATE UNIQUE INDEX editorial_publications_active_slug
  ON editorial_publications(slug) WHERE withdrawn_at IS NULL;
CREATE INDEX editorial_publications_active_date
  ON editorial_publications(published_at DESC,id DESC)
  WHERE withdrawn_at IS NULL;

CREATE FUNCTION preserve_editorial_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'editorial publication rows are immutable';
  END IF;
  IF NOT (
    OLD.withdrawn_at IS NULL
    AND NEW.withdrawn_at IS NOT NULL
    AND NEW.id=OLD.id
    AND NEW.slug=OLD.slug
    AND NEW.tenant_id=OLD.tenant_id
    AND NEW.artifact_id=OLD.artifact_id
    AND NEW.revision_id=OLD.revision_id
    AND NEW.share_id=OLD.share_id
    AND NEW.derivative_id IS NOT DISTINCT FROM OLD.derivative_id
    AND NEW.source_sha256=OLD.source_sha256
    AND NEW.manifest_sha256 IS NOT DISTINCT FROM OLD.manifest_sha256
    AND NEW.derivative_sha256 IS NOT DISTINCT FROM OLD.derivative_sha256
    AND NEW.builder_version IS NOT DISTINCT FROM OLD.builder_version
    AND NEW.runtime_profile IS NOT DISTINCT FROM OLD.runtime_profile
    AND NEW.metadata=OLD.metadata
    AND NEW.request=OLD.request
    AND NEW.request_hash=OLD.request_hash
    AND NEW.published_at=OLD.published_at
  ) THEN
    RAISE EXCEPTION 'editorial publication rows are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER editorial_publication_immutable
  BEFORE UPDATE OR DELETE ON editorial_publications
  FOR EACH ROW EXECUTE FUNCTION preserve_editorial_publication();
