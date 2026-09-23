-- Abuse protection for open sign-up (docs/specs/ABUSE_PROTECTION.md, 1–7).
--
-- accounts.created_at        When the account was created. NULL for accounts
--                            older than this migration (not recorded then);
--                            they count as old.
-- accounts.trusted_at        Set when the operator created the account
--                            (password login) or approved its author. The
--                            other path to trust (age without open reports)
--                            is computed, not stored.
-- shares.moderation          none: opens as usual; held: waits for review
--                            before its first open; paused: stopped after
--                            reports. Recipients of held/paused links see a
--                            review screen, never the title or content.
-- revisions.phishing_signals What the save-time scan found (secret fields,
--                            brands, urgency), e.g. {secret:password,brand:Сбер}.
--                            Empty for older revisions and ordinary pages.
-- share_reports.reporter_hash HMAC(LINK_KEY, ip|share_id): distinct reporters
--                            per link without storing their addresses.

ALTER TABLE accounts ADD COLUMN created_at timestamptz;
ALTER TABLE accounts ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE accounts ADD COLUMN trusted_at timestamptz;
-- Every account that exists today is a known pilot user.
UPDATE accounts SET trusted_at=now() WHERE trusted_at IS NULL;

ALTER TABLE shares
  ADD COLUMN moderation text NOT NULL DEFAULT 'none'
    CHECK (moderation IN ('none','held','paused')),
  ADD COLUMN moderation_reason text
    CHECK (char_length(moderation_reason) <= 200),
  ADD COLUMN moderated_at timestamptz;
CREATE INDEX shares_moderation_queue ON shares(tenant_id)
  WHERE moderation <> 'none' AND NOT revoked;

ALTER TABLE revisions
  ADD COLUMN phishing_signals text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(phishing_signals) <= 64);

ALTER TABLE share_reports
  ADD COLUMN reporter_hash text CHECK (reporter_hash ~ '^[a-f0-9]{64}$');
CREATE INDEX share_reports_reporters ON share_reports(share_id, created_at);
