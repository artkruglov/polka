-- The installation-wide journal for extensions (docs/specs/EXTENSIONS.md,
-- context.auditFeed): its head and its pages read audit_outbox in commit
-- order across every shelf; without this the poll scans the whole table.
CREATE INDEX audit_outbox_feed_all ON audit_outbox ((COALESCE(tx_id, '0'::xid8)), id);
