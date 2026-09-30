-- Letters to the author about a link under review (docs/specs/LINK_REVIEW_LETTERS.md).
--
-- shares.review_notified_at   the author was told the link waits for review
-- shares.release_notified_at  the author was told it was approved and opens
-- Both empty again is not needed: a link held a second time (a new version
-- moved onto it) is told about once its first round is complete.
ALTER TABLE shares
  ADD COLUMN review_notified_at timestamptz,
  ADD COLUMN release_notified_at timestamptz;
