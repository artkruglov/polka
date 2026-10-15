-- Onboarding decisions of 15.10.2026 (docs/specs/ONBOARDING_V2.md).
--
-- accounts.onboarding_hidden_at  when the owner pressed «Скрыть» on the shelf's
--                                «Подключите агента» block; NULL: not hidden.
--                                Account state, so it holds in every browser
--                                (before 077 it lived in localStorage only).
-- audit_outbox_saved             who saved a version (Artifact.savedBy): the
--                                shelf list looks up the 'revision.saved'
--                                row of each work's latest revision by its id.
--                                Partial, so it holds only that action.
ALTER TABLE accounts ADD COLUMN onboarding_hidden_at timestamptz;
CREATE INDEX audit_outbox_saved ON audit_outbox (tenant_id, target_id)
  WHERE action = 'revision.saved';
