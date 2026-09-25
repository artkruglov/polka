-- Search over the text of works (docs/specs/CONTENT_SEARCH.md).
--
-- artifact_search  one row per work: the text of its latest revision (up to
--                  60 000 characters) and its tsvector ('russian'). The row
--                  goes with the work and the revision (ON DELETE CASCADE),
--                  so account erasure, provisional shelves and merges need no
--                  code of their own; it has no tenant_id to keep in step.
CREATE TABLE artifact_search (
  artifact_id uuid PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 60000),
  document tsvector GENERATED ALWAYS AS (to_tsvector('russian', body)) STORED,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifact_search_document ON artifact_search USING gin (document);
CREATE INDEX artifact_search_revision ON artifact_search (revision_id);
