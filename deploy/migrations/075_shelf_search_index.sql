-- The shelf list and its search without whole-installation scans
-- (docs/specs/CONTENT_SEARCH.md, «Индекс»).
--
-- artifact_search.tenant_id  the work's shelf, kept in step by the foreign
--                            key (ON UPDATE CASCADE: an account merge moves
--                            works between shelves). The text index holds the
--                            shelf as one more lexeme, '~<tenant id>', which
--                            no search box can produce: a search ANDs it in,
--                            so a common word reads only the posting lists of
--                            its shelf instead of every work that has it.
--                            A two-column GIN (btree_gin) would do the same,
--                            but its trusted-extension install needs CREATE on
--                            the database, which the schema owner does not
--                            have (deploy/hosted/init-roles.sh), and leaves
--                            functions owned by the superuser in public,
--                            which the grants recipes refuse.
-- artifacts.title_document   the title's tsvector ('russian'), stored: a
--                            search no longer parses every title of the
--                            shelf per request.
-- artifacts.latest_mime      the MIME type of the latest version, for the
--                            kind chips of the shelf (pages, documents,
--                            images, other) without a revisions lookup per
--                            work. A trigger copies it whenever
--                            latest_revision_id is set; a version's MIME type
--                            never changes.
-- agent_session_tool_calls   two partial covering indexes for the company's
--                            session statistics («Сеть», «MCP»): only the
--                            calls that went to the network or to an MCP
--                            server, readable without the table.

ALTER TABLE artifact_search ADD COLUMN tenant_id uuid;
UPDATE artifact_search s SET tenant_id=a.tenant_id FROM artifacts a WHERE a.id=s.artifact_id;
ALTER TABLE artifact_search
  ALTER COLUMN tenant_id SET NOT NULL,
  DROP CONSTRAINT artifact_search_artifact_id_fkey,
  ADD CONSTRAINT artifact_search_work FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES artifacts(tenant_id, id) ON UPDATE CASCADE ON DELETE CASCADE;
DROP INDEX artifact_search_document;
CREATE INDEX artifact_search_shelf_document ON artifact_search
  USING gin ((document || ('~' || tenant_id::text)::tsvector));

ALTER TABLE artifacts ADD COLUMN latest_mime text;
UPDATE artifacts a SET latest_mime=r.mime FROM revisions r WHERE r.id=a.latest_revision_id;
-- After the UPDATE: the rewrite for the stored column also drops its old row versions.
ALTER TABLE artifacts
  ADD COLUMN title_document tsvector GENERATED ALWAYS AS (to_tsvector('russian', title)) STORED;

CREATE FUNCTION artifact_latest_mime() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.latest_mime := (SELECT mime FROM public.revisions WHERE id=NEW.latest_revision_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION artifact_latest_mime() FROM PUBLIC;
CREATE TRIGGER artifact_latest_mime
  BEFORE INSERT OR UPDATE OF latest_revision_id ON artifacts
  FOR EACH ROW EXECUTE FUNCTION artifact_latest_mime();

CREATE INDEX agent_session_tool_calls_network ON agent_session_tool_calls (session_id)
  INCLUDE (hosts) WHERE hosts <> '{}';
CREATE INDEX agent_session_tool_calls_mcp ON agent_session_tool_calls (session_id)
  INCLUDE (mcp_server, status) WHERE mcp_server IS NOT NULL;
