-- Shelf covers (docs/specs/SHELF_COVERS.md): how a saved version looks on the
-- shelf, decided once per version and kept with it.
--
--   kind, genre   text (a typographic cover) or visual (a picture of the
--                 first screen); the genre names it on the card.
--   facts         the heading, lead and accent colour the cover shows, and the
--                 signals the decision was made from (cover-facts.ts). Small.
--   version       the reader's COVER_VERSION: an older row is recomputed when
--                 a card asks for it.
--   image         a JPEG of the first screen (about 960×600), drawn by the
--                 isolated renderer. Kept here, not in object storage, so that
--                 it goes with its version: every deletion of a revision
--                 (trash, provisional shelves, account purge, erasure
--                 replay) cascades to it and no object is left behind.
--   image_state   none: no picture is wanted (a text cover, a link);
--                 wanted: waits for the renderer (or for it to be enabled);
--                 pending: a renderer attempt holds it until
--                 attempt_expires_at; ready; failed (reason says why).
--
-- The runtime reads and writes rows; the scripts/backfill-covers.ts backfill
-- runs as the runtime role too.
CREATE TABLE revision_covers (
  revision_id uuid PRIMARY KEY REFERENCES revisions(id) ON DELETE CASCADE,
  version smallint NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('text','visual')),
  genre text NOT NULL CHECK (char_length(genre) BETWEEN 1 AND 20),
  facts jsonb NOT NULL CHECK (pg_column_size(facts) <= 4096),
  image_state text NOT NULL CHECK (image_state IN ('none','wanted','pending','ready','failed')),
  image bytea CHECK (image IS NULL OR octet_length(image) <= 262144),
  image_sha256 text CHECK (image_sha256 ~ '^[a-f0-9]{64}$'),
  image_source text CHECK (image_source IN ('source','derivative')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  attempt_expires_at timestamptz,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((image_state='ready') = (image IS NOT NULL AND image_sha256 IS NOT NULL)),
  CHECK ((image_state='pending') = (attempt_expires_at IS NOT NULL))
);
-- The renderer queue picks wanted and expired pending rows.
CREATE INDEX revision_covers_waiting ON revision_covers(updated_at)
  WHERE image_state IN ('wanted','pending');
