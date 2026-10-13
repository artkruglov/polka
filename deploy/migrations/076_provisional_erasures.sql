-- Erasures of idle provisional shelves that maintenance closed itself
-- (ACCOUNT_DELETION_ENABLED=false, apps/server/provisional-maintenance.ts).
--
-- provisional_erasures  one row per shelf closed for erasure, written in the
--                       same transaction that closes it. The objects go
--                       next, then the rows; the row goes with the rows.
--                       A run that fails or stops between those steps (S3
--                       down, the deadline, the process exits) leaves it,
--                       and the next run finishes the shelf. Before 076 the
--                       shelf stayed half erased: closed, so the idle scan no
--                       longer found it, with its objects and rows kept.
CREATE TABLE provisional_erasures (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  closed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provisional_erasures_closed ON provisional_erasures (closed_at);
