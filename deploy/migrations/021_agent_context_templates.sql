ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_scopes_check,
 ADD CONSTRAINT agent_connections_scopes_check CHECK (
 cardinality(scopes) BETWEEN 1 AND 7 AND scopes <@ ARRAY['context','read','source:read','capture','revise','share','manage']::text[]);
CREATE TABLE template_releases (
 id uuid PRIMARY KEY,
 artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
 title text NOT NULL,
 summary text NOT NULL CHECK(char_length(summary) BETWEEN 1 AND 600),
 rules text NOT NULL CHECK(char_length(rules) BETWEEN 1 AND 6000),
 questions text NOT NULL CHECK(char_length(questions)<=3000),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(artifact_id,revision_id)
);
CREATE INDEX template_releases_catalog ON template_releases(created_at DESC,id);
