-- Prohibited-content filter, blocking and the moderation journal
-- (docs/specs/CONTENT_FILTER.md).
--
-- shares.moderation          + blocked: closed by the operator or the filter.
--                            Recipients see «Ссылка недоступна», never the
--                            title or content; no grant is issued.
-- revisions.content_filter   What the save-time scan found: categories with
--                            scores and the list terms that matched (ours,
--                            never the user's text), listed domains, a
--                            SimHash of the visible text for near-duplicates,
--                            and the model's cached verdict. {} for older
--                            revisions.
-- revisions.content_purged_at The objects of a blocked revision were deleted
--                            (every S3 version). The row stays as a tombstone:
--                            ids, size, sha256, mime.
-- comments.content_filter    The same for a comment's text.
-- comments.blocked_at        Blocked: nobody sees it; its text is emptied
--                            when the block's evidence window ends.
-- comments.shadow            Held as spam: only its author sees it, as if it
--                            waited for review.
-- moderation_blocks          One blocked revision or comment: the category,
--                            the content's sha256 (a stop list: the same bytes
--                            cannot be saved or linked again by anyone),
--                            isolated (nobody sees it, the owner included;
--                            soft categories only close links), when it is
--                            deleted (delete_after by the category's retention;
--                            NULL: not on a schedule), an operator's legal
--                            hold that stops deletion, when it was handed to
--                            the police, when the operator was reminded of
--                            the deletion, and when it was purged or released
--                            (unblocked). No foreign keys: the row outlives
--                            the account.
-- moderation_events          The journal: who (filter, model, operator by
--                            mail or script, maintenance, reports, sign-up),
--                            what, when, over which ids, why (categories,
--                            scores, list terms, reason, an authority's
--                            request) and evidence metadata (sha256, sizes,
--                            mime). Never content, titles or file names.
--                            Append-only: UPDATE is refused, DELETE only for
--                            events older than 3 years (maintenance).

ALTER TABLE shares DROP CONSTRAINT shares_moderation_check;
ALTER TABLE shares ADD CONSTRAINT shares_moderation_check
  CHECK (moderation IN ('none','held','paused','blocked'));

ALTER TABLE revisions
  ADD COLUMN content_filter jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(content_filter)='object'
      AND octet_length(content_filter::text) <= 16384),
  ADD COLUMN content_purged_at timestamptz;
-- Near-duplicates published from several accounts: the last day's texts.
CREATE INDEX revisions_recent_fingerprint ON revisions(created_at)
  WHERE content_filter ? 'simhash';
CREATE INDEX revisions_content_sha256 ON revisions(sha256, created_at);

ALTER TABLE comments
  ADD COLUMN content_filter jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(content_filter)='object'
      AND octet_length(content_filter::text) <= 8192),
  ADD COLUMN blocked_at timestamptz,
  ADD COLUMN shadow boolean NOT NULL DEFAULT false;

CREATE TABLE moderation_blocks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  artifact_id uuid,
  revision_id uuid UNIQUE,
  comment_id uuid UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  category text NOT NULL CHECK (category IN (
    'csam','extremism_terror','drugs','weapons_explosives','doxxing','porn',
    'suicide','gambling','piracy','blocklisted_domain','fraud','spam','vpn',
    'malicious_code','copyright','other')),
  blocked_at timestamptz NOT NULL DEFAULT now(),
  isolated boolean NOT NULL,
  delete_after timestamptz,
  legal_hold text CHECK (char_length(legal_hold) BETWEEN 1 AND 500),
  handed_over_at timestamptz,
  reminded_at timestamptz,
  purged_at timestamptz,
  released_at timestamptz,
  CHECK ((revision_id IS NULL) <> (comment_id IS NULL)),
  CHECK (revision_id IS NULL OR artifact_id IS NOT NULL)
);
CREATE INDEX moderation_blocks_sha256 ON moderation_blocks(sha256)
  WHERE released_at IS NULL;
CREATE INDEX moderation_blocks_due ON moderation_blocks(delete_after)
  WHERE purged_at IS NULL AND released_at IS NULL AND legal_hold IS NULL
    AND delete_after IS NOT NULL;
CREATE INDEX moderation_blocks_tenant ON moderation_blocks(tenant_id)
  WHERE released_at IS NULL;

-- Reports that stop a link at the first one (docs/specs/CONTENT_FILTER.md).
ALTER TABLE share_reports DROP CONSTRAINT share_reports_reason_check;
ALTER TABLE share_reports ADD CONSTRAINT share_reports_reason_check
  CHECK (reason IN ('phishing','malware','personal_data','illegal','other',
    'child_sexual','intimate_nonconsensual','threat_to_life'));

CREATE TABLE moderation_events (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor text NOT NULL CHECK (actor IN (
    'filter','model','operator-mail','operator-script','maintenance',
    'reports','signup')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z._-]{1,63}$'),
  category text CHECK (category IN (
    'csam','extremism_terror','drugs','weapons_explosives','doxxing','porn',
    'suicide','gambling','piracy','blocklisted_domain','fraud','spam','vpn',
    'malicious_code','copyright','other')),
  account_id uuid,
  tenant_id uuid,
  artifact_id uuid,
  revision_id uuid,
  share_id uuid,
  comment_id uuid,
  reason text CHECK (char_length(reason) <= 2000),
  authority text CHECK (char_length(authority) <= 500),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details)='object'
      AND octet_length(details::text) <= 16384)
);
CREATE INDEX moderation_events_time ON moderation_events(created_at);
CREATE INDEX moderation_events_account ON moderation_events(account_id, created_at)
  WHERE account_id IS NOT NULL;
CREATE INDEX moderation_events_share ON moderation_events(share_id, created_at)
  WHERE share_id IS NOT NULL;

CREATE FUNCTION moderation_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'moderation_events are append-only';
  END IF;
  IF OLD.created_at > now() - interval '3 years' THEN
    RAISE EXCEPTION 'moderation_events are kept for 3 years';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER moderation_events_append_only
  BEFORE UPDATE OR DELETE ON moderation_events
  FOR EACH ROW EXECUTE FUNCTION moderation_events_append_only();
