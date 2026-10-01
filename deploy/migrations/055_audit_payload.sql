-- A typed payload of an audit event, and the transaction that wrote it, for
-- the events feed (docs/specs/DATA_MODELS.md §5, GET /api/v1/events).
--
-- payload: ids only, never the content of a work or a link secret. Null for
-- every row written before this migration and for actions that need nothing
-- beyond target_id. Erased with the shelf's audit rows (the purge deletes by
-- tenant).
--
-- tx_id: the writing transaction. A bigserial id is taken at insert, but the
-- row shows only at commit, so a poller that remembers the highest id seen
-- can miss a row that commits later with a lower one. The feed therefore
-- reads in (tx_id, id) order and only rows of transactions older than every
-- one still running (pg_snapshot_xmin), which nothing can ever precede.
-- Rows from before this migration have no tx_id and read as the oldest.
ALTER TABLE audit_outbox ADD COLUMN payload jsonb NULL;
ALTER TABLE audit_outbox ADD COLUMN tx_id xid8 NULL;
ALTER TABLE audit_outbox ALTER COLUMN tx_id SET DEFAULT pg_current_xact_id();
CREATE INDEX audit_outbox_feed ON audit_outbox (tenant_id, tx_id, id);
