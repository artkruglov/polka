ALTER TABLE artifacts
  ADD COLUMN trashed_at timestamptz,
  ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 0
    CHECK (lifecycle_version >= 0);

CREATE INDEX shelf_active_page
  ON artifacts(tenant_id,updated_at DESC,id DESC)
  WHERE trashed_at IS NULL;

CREATE INDEX trash_page
  ON artifacts(tenant_id,trashed_at DESC,id DESC)
  WHERE trashed_at IS NOT NULL;

-- A pending derivative must remember the lifecycle generation in which its
-- worker was admitted. Existing artifacts are all generation zero at migration
-- time, so the default is the exact generation for every existing row.
ALTER TABLE revision_derivatives
  ADD COLUMN artifact_lifecycle_version integer NOT NULL DEFAULT 0
    CHECK (artifact_lifecycle_version >= 0);
