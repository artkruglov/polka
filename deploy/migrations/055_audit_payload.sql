-- A typed payload of an audit event, for the events feed
-- (docs/specs/DATA_MODELS.md §5, GET /api/v1/events).
--
-- Ids only, never the content of a work or a link secret. Null for every row
-- written before this migration and for actions that need nothing beyond
-- target_id. Erased with the shelf's audit rows (the purge deletes by tenant).
ALTER TABLE audit_outbox ADD COLUMN payload jsonb NULL;
