-- Search across shelves for an agent (docs/specs/DATA_MODELS.md §7): the
-- department shelves the person allowed this connection to read besides its
-- own, named at issue. Empty (the default, and what every existing connection
-- has) means its own shelf only. Membership and role are still checked on each
-- shelf at each call, so leaving a shelf closes it for the agent.
ALTER TABLE agent_connections
  ADD COLUMN allowed_shelf_ids uuid[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(allowed_shelf_ids) <= 10);
