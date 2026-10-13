-- Which organisation's directory deprovisioned an account
-- (docs/specs/EXTENSIONS.md, context.accounts). An extension's account calls
-- act for one organisation and only for its people; reactivate lifts a
-- deprovision only for the organisation that made it.
--
-- accounts  + deprovisioned_organisation_id: set with deprovisioned_at by an
--             extension's deprovision, cleared with it by reactivate. NULL
--             while deprovisioned_at is set: a deprovision made before 073,
--             or one whose organisation is gone; then the organisation the
--             person belongs to now (a verified address on its domain) may
--             lift it.
ALTER TABLE accounts
  ADD COLUMN deprovisioned_organisation_id uuid NULL REFERENCES organisations(id) ON DELETE SET NULL,
  ADD CONSTRAINT accounts_deprovision_organisation
    CHECK (deprovisioned_organisation_id IS NULL OR deprovisioned_at IS NOT NULL);
