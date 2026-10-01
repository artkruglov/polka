-- Who answers for a work and which version was accepted
-- (docs/specs/DATA_MODELS.md §1).
--
-- owner_account_id: the person responsible, optional (a department's works
-- belong to the shelf). accepted_revision_id: the version a curator marked as
-- accepted; null means no mark, and no old work is marked afterwards. A link
-- stays on its own version (shares.revision_id); neither column moves it.
-- Both are cleared if the account or the version goes away.
ALTER TABLE artifacts
  ADD COLUMN owner_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN accepted_revision_id uuid NULL REFERENCES revisions(id) ON DELETE SET NULL;
