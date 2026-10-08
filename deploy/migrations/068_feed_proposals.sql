-- A curator of a department shelf proposes one version of a work to «Лента»
-- (docs/specs/DISCOVER_V2.md, «Предложение с полки отдела»). The operator
-- reviews it by hand (npm run feed:proposals) and publishes through the
-- existing editorial path; nothing here is shown in «Лента» by itself.
--
-- state: pending → published | rejected (the operator) | withdrawn (the shelf,
-- or the work went to the trash). One pending proposal per work.
CREATE TABLE feed_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  proposed_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  summary text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','published','rejected','withdrawn')),
  reason text CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  FOREIGN KEY (tenant_id,artifact_id,revision_id)
    REFERENCES revisions(tenant_id,artifact_id,id),
  CHECK ((state='pending') = (decided_at IS NULL)),
  CHECK (state<>'rejected' OR reason IS NOT NULL)
);

CREATE UNIQUE INDEX feed_proposals_one_pending
  ON feed_proposals (artifact_id) WHERE state='pending';
CREATE INDEX feed_proposals_work
  ON feed_proposals (artifact_id, created_at DESC);
CREATE INDEX feed_proposals_queue
  ON feed_proposals (created_at) WHERE state='pending';
