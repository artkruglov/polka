-- A bundle whose manifest holds only its HTML entrypoint is the same page a
-- single upload would be, so it may carry the classified static/limited
-- profile. Multi-file bundles still require a prepared runtime derivative.
ALTER TABLE revisions DROP CONSTRAINT bundle_revision_shape;
ALTER TABLE revisions ADD CONSTRAINT bundle_revision_shape CHECK (
  storage_kind <> 'bundle'
  OR (
    mime='text/html'
    AND manifest IS NOT NULL
    AND manifest_sha256 IS NOT NULL
    AND (
      html_profile='unsupported'
      OR (
        html_profile IN ('static','limited')
        AND jsonb_array_length(manifest->'files')=1
        AND manifest->'files'->0->>'path'=manifest->>'entrypoint'
      )
    )
  )
);
