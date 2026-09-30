-- How often a link was opened, for its author (docs/specs/LINK_OPENS.md).
--
-- One row per link and UTC day: how many times recipients opened it and when
-- last. No reader is named or identified: the number is all there is. The
-- owner's own opening is not counted (app.ts, /api/resolve). The rows go with
-- the link (ON DELETE CASCADE), so erasing a shelf needs no change.
CREATE TABLE share_open_days (
  share_id uuid NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  day date NOT NULL,
  opens integer NOT NULL CHECK (opens > 0),
  last_opened_at timestamptz NOT NULL,
  PRIMARY KEY (share_id, day)
);
