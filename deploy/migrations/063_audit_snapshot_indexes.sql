-- Indexes for the shelf snapshot (docs/specs/SHELF_SNAPSHOT.md): per work, the
-- last acceptance and the last move to or from the trash before a moment.
-- Partial, so they hold only these few actions of audit_outbox.
CREATE INDEX audit_outbox_acceptance ON audit_outbox (tenant_id, target_id, created_at DESC, id DESC)
  WHERE action = 'revision.accepted';
CREATE INDEX audit_outbox_trash ON audit_outbox (tenant_id, target_id, created_at DESC, id DESC)
  WHERE action IN ('artifact.trashed', 'artifact.restored');
