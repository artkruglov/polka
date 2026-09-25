-- A one-time token for uploading a project (docs/specs/PROJECTS.md): an agent
-- asks for it over MCP (polka_project_upload) and runs the CLI with it, so a
-- person does not copy a token by hand.
--
-- agent_connections
--   + parent_id: the connection that asked for this token. Such a token has
--     the audience <origin>/api/v1/projects (only the project routes accept
--     it), lives 30 minutes and stops as soon as its parent is revoked or
--     expires. It is not listed on the agents page.
ALTER TABLE agent_connections
  ADD COLUMN parent_id uuid REFERENCES agent_connections(id) ON DELETE CASCADE,
  ADD CONSTRAINT agent_connections_child_shape CHECK (
    parent_id IS NULL OR (oauth_client_id IS NULL AND expires_at <= created_at + interval '30 minutes')
  );
CREATE INDEX agent_connections_parent ON agent_connections (parent_id) WHERE parent_id IS NOT NULL;
