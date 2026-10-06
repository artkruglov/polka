// Whether a version's bytes may be read: moderation isolated them, or deleted
// them. Shared by the shelf export (shelf-export.ts) and the extension content
// API (extension-content.ts), so both refuse the same versions.

/** For SQL: 'removed', 'blocked' or NULL for revision alias `r`. */
export const unavailableSql = (r: string) => `CASE
  WHEN ${r}.content_purged_at IS NOT NULL THEN 'removed'
  WHEN EXISTS(SELECT 1 FROM moderation_blocks block
              WHERE block.revision_id=${r}.id AND block.isolated AND block.released_at IS NULL)
    THEN 'blocked' END`;
