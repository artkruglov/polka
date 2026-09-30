-- Delete a work for good (docs/specs/WORK_DELETION.md): the owner empties it
-- from the trash. Its objects are deleted from the store and its text leaves
-- search and the shelf cover, as when moderation deletes content; the rows stay
-- as tombstones (the same way), hidden from every list.
--
-- artifacts.purged_at  set when the owner chose to delete; the work is gone from
--                      the trash and every read at once, the objects follow and
--                      revisions.content_purged_at says each version is done.
ALTER TABLE artifacts ADD COLUMN purged_at timestamptz;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_purged_in_trash
  CHECK (purged_at IS NULL OR trashed_at IS NOT NULL);
CREATE INDEX artifacts_purging ON artifacts (purged_at) WHERE purged_at IS NOT NULL;
