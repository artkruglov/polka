-- Video in projects (docs/specs/PROJECT_VIDEO.md).
--
-- revision_files.size  a video file is up to 200 MiB (PROJECT_VIDEO_MAX_FILE_BYTES);
--                      every other file stays within 5 MiB.
-- revisions.total_size a project is up to 48 MiB of pages, pictures and text
--                      plus 400 MiB of video (PROJECT_MAX_BYTES + PROJECT_VIDEO_MAX_BYTES).
-- tenants.video_enabled video is saved only on a shelf that has it: Полка cannot
--                      screen video yet, so an operator turns it on per shelf.
ALTER TABLE revision_files DROP CONSTRAINT revision_files_size_check;
ALTER TABLE revision_files ADD CONSTRAINT revision_files_size_check CHECK (
  size >= 0 AND (
    size <= 5242880
    OR (mime IN ('video/mp4','video/webm') AND size <= 209715200)
  )
);

ALTER TABLE revisions DROP CONSTRAINT revision_total_size;
ALTER TABLE revisions ADD CONSTRAINT revision_total_size CHECK (
  total_size >= size AND (
    total_size <= 5242880
    OR (storage_kind = 'bundle' AND manifest->>'runtime' = 'project-v1'
        AND total_size <= 469762048)
  )
);

ALTER TABLE tenants ADD COLUMN video_enabled boolean NOT NULL DEFAULT false;
