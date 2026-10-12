-- Why an account is disabled (docs/specs/EXTENSIONS.md, context.accounts).
-- accounts.disabled stays the one flag every check reads; these columns say
-- which reasons hold, so lifting one never lifts another:
--
-- accounts  + operator_disabled_at: the operator or moderation disabled it
--             (npm run admin -- moderation disable, a freeze). Lifted only by
--             the operator's enable.
--           + deprovisioned_at, deprovisioned_by: an extension's directory
--             (SSO, SCIM) says the person is gone. Lifted only by the
--             extension's reactivate.
--
-- The account stays disabled while either reason holds (the CHECK). An
-- account being deleted is disabled by its deletion request, as before.
-- Existing disabled accounts are recorded as the operator's: only the
-- operator could disable one until now.
ALTER TABLE accounts
  ADD COLUMN operator_disabled_at timestamptz,
  ADD COLUMN deprovisioned_at timestamptz,
  ADD COLUMN deprovisioned_by text CHECK (deprovisioned_by ~ '^[a-z][a-z0-9-]{1,30}$'),
  ADD CONSTRAINT accounts_deprovision_shape CHECK ((deprovisioned_at IS NULL) = (deprovisioned_by IS NULL));

UPDATE accounts SET operator_disabled_at = now() WHERE disabled;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_disabled_while_held
    CHECK (disabled OR (operator_disabled_at IS NULL AND deprovisioned_at IS NULL));
