-- Indexes for two lookups that read whole tables (pre-launch review).
--
-- shares_revision            the links of a revision: moving a link, the
--                            content filter and erasure look them up by
--                            revision_id, which no index covered.
-- artifacts_live_folder      the live works of a folder on a shelf: the
--                            folder list's counts, an agent's folder scope
--                            and deleting a folder.
--
-- Plain CREATE INDEX: the migration set runs in one transaction, which
-- CONCURRENTLY cannot. Both tables are small at launch.
CREATE INDEX shares_revision ON shares (revision_id);

CREATE INDEX artifacts_live_folder ON artifacts (tenant_id, folder_id)
  WHERE trashed_at IS NULL;
