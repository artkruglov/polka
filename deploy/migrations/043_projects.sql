-- Projects (docs/specs/PROJECTS.md): one work of many linked pages, a bundle
-- whose manifest runtime is 'project-v1'. Only projects get the larger
-- limits; every other bundle keeps 64 files and 5 MiB in all.
--
-- upload_files, revision_files  file_index below 400 (PROJECT_MAX_FILES);
--                               each file still at most 5 MiB.
-- revisions  total_size up to 48 MiB for a project (PROJECT_MAX_BYTES);
--            a project's entry may be its README (text/markdown, no html
--            profile) or an HTML page.
ALTER TABLE upload_files
  DROP CONSTRAINT upload_files_file_index_check,
  ADD CONSTRAINT upload_files_file_index_check CHECK (file_index >= 0 AND file_index < 400);
ALTER TABLE revision_files
  DROP CONSTRAINT revision_files_file_index_check,
  ADD CONSTRAINT revision_files_file_index_check CHECK (file_index >= 0 AND file_index < 400);

ALTER TABLE revisions DROP CONSTRAINT revision_total_size;
ALTER TABLE revisions ADD CONSTRAINT revision_total_size CHECK (
  total_size >= size AND (
    total_size <= 5242880
    OR (storage_kind = 'bundle' AND manifest->>'runtime' = 'project-v1'
        AND total_size <= 50331648)
  )
);

ALTER TABLE revisions DROP CONSTRAINT bundle_revision_shape;
ALTER TABLE revisions ADD CONSTRAINT bundle_revision_shape CHECK (
  storage_kind <> 'bundle'
  OR (
    manifest IS NOT NULL
    AND manifest_sha256 IS NOT NULL
    AND (
      (
        mime = 'text/html'
        AND (
          html_profile = 'unsupported'
          OR (
            html_profile IN ('static','limited')
            AND jsonb_array_length(manifest->'files') = 1
            AND manifest->'files'->0->>'path' = manifest->>'entrypoint'
          )
        )
      )
      OR (mime = 'text/markdown' AND manifest->>'runtime' = 'project-v1')
    )
  )
);
