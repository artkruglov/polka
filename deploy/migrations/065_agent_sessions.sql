-- Agent sessions (docs/specs/AGENT_SESSIONS.md): a person's Claude Code and
-- Codex sessions, sent by polka-sessions.mjs with secrets already redacted on
-- the machine. Not works: no versions, no review, no shelf search. Only the
-- last upload of a session is kept. Names start with agent_session because
-- `sessions` holds web sign-ins.

-- A separate allowance; 0 = sessions are off for this shelf unless the
-- installation's AGENT_SESSION_QUOTA_BYTES grants more. The key makes secret
-- fingerprints comparable between the person's machines (HMAC on the machine).
ALTER TABLE tenants
  ADD COLUMN session_quota_bytes bigint NOT NULL DEFAULT 0 CHECK (session_quota_bytes >= 0),
  ADD COLUMN session_used_bytes bigint NOT NULL DEFAULT 0 CHECK (session_used_bytes >= 0),
  ADD COLUMN session_fingerprint_key bytea;

CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('claude-code', 'codex')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  project_label text CHECK (length(project_label) <= 200),
  project_remote text CHECK (length(project_remote) <= 500),
  git_branch text CHECK (length(git_branch) <= 200),
  cli_version text CHECK (length(cli_version) <= 50),
  permission_mode text CHECK (length(permission_mode) <= 100),
  started_at timestamptz,
  ended_at timestamptz,
  turns integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  prompts integer NOT NULL DEFAULT 0 CHECK (prompts >= 0),
  tool_call_count integer NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  tokens jsonb NOT NULL DEFAULT '{}',
  models jsonb NOT NULL DEFAULT '{}',
  cost_usd numeric(14, 6),
  cost_estimated boolean NOT NULL DEFAULT false,
  secrets_status text NOT NULL DEFAULT 'clean' CHECK (secrets_status IN ('clean', 'seen', 'used', 'sent_out')),
  alerts jsonb NOT NULL DEFAULT '[]',
  transcript_key text,
  transcript_version text,
  transcript_bytes bigint NOT NULL DEFAULT 0 CHECK (transcript_bytes >= 0),
  -- The compressed index as sent; with the transcript it counts toward the allowance.
  index_bytes bigint NOT NULL DEFAULT 0 CHECK (index_bytes >= 0),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, external_id)
);
CREATE INDEX agent_sessions_list ON agent_sessions (tenant_id, account_id, started_at DESC NULLS LAST);

CREATE TABLE agent_session_tool_calls (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 0),
  at timestamptz,
  tool text NOT NULL CHECK (length(tool) <= 200),
  kind text NOT NULL CHECK (kind IN ('shell', 'edit', 'read', 'web', 'mcp', 'task', 'other')),
  mcp_server text CHECK (length(mcp_server) <= 100),
  status text NOT NULL CHECK (status IN ('ok', 'error', 'interrupted', 'unknown')),
  duration_ms bigint,
  exit_code integer,
  input_bytes bigint NOT NULL DEFAULT 0,
  output_bytes bigint NOT NULL DEFAULT 0,
  argv0 text CHECK (length(argv0) <= 100),
  template text CHECK (length(template) <= 200),
  hosts text[] NOT NULL DEFAULT '{}',
  network boolean NOT NULL DEFAULT false,
  subagent boolean NOT NULL DEFAULT false,
  PRIMARY KEY (session_id, seq)
);

-- Never a value: the type, a keyed fingerprint, a short prefix like "ghp_"
-- and where the secret was seen.
CREATE TABLE agent_session_secrets (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{12}$'),
  type text NOT NULL CHECK (length(type) <= 50),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  prefix text CHECK (length(prefix) <= 20),
  length integer NOT NULL CHECK (length >= 0),
  occurrences integer NOT NULL CHECK (occurrences >= 0),
  seen_by_model boolean NOT NULL DEFAULT false,
  model_emitted boolean NOT NULL DEFAULT false,
  to_command boolean NOT NULL DEFAULT false,
  to_network boolean NOT NULL DEFAULT false,
  written_to_file boolean NOT NULL DEFAULT false,
  PRIMARY KEY (session_id, fingerprint)
);

-- What the session produced: a work on this shelf, a pull request.
CREATE TABLE agent_session_links (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('work', 'pr')),
  target text NOT NULL CHECK (length(target) <= 500),
  artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  PRIMARY KEY (session_id, kind, target)
);
CREATE INDEX agent_session_links_artifact ON agent_session_links (artifact_id) WHERE artifact_id IS NOT NULL;

-- The agent token right `sessions` («Сессии агентов»): polka-sessions.mjs
-- uploads with it, polka_sessions reads with it. Off unless chosen.
ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_scopes_check,
  ADD CONSTRAINT agent_connections_scopes_check CHECK (
    cardinality(scopes) BETWEEN 1 AND 9
    AND scopes <@ ARRAY['context','read','source:read','capture','revise','share','manage','sign_in','sessions']::text[]);
ALTER TABLE oauth_authorizations
  DROP CONSTRAINT oauth_authorizations_requested_scopes_check,
  ADD CONSTRAINT oauth_authorizations_requested_scopes_check CHECK (
    cardinality(requested_scopes) BETWEEN 1 AND 9
    AND requested_scopes <@ ARRAY['context','read','source:read','capture','revise','share','manage','sign_in','sessions']::text[]),
  DROP CONSTRAINT oauth_authorizations_granted_scopes_check,
  ADD CONSTRAINT oauth_authorizations_granted_scopes_check CHECK (
    cardinality(granted_scopes) BETWEEN 1 AND 9
    AND granted_scopes <@ ARRAY['context','read','source:read','capture','revise','share','manage','sign_in','sessions']::text[]);

-- Erasure: the tenants row stays, so the cascades never fire. When the
-- erasure renames the account (030), its sessions go with their rows; the
-- objects under <tenant>/sessions/ go with the shelf's prefix (account-purge).
CREATE FUNCTION erase_account_agent_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  DELETE FROM public.agent_sessions WHERE account_id=NEW.id;
  UPDATE public.tenants
     SET session_used_bytes=0, session_fingerprint_key=NULL
   WHERE owner_id=NEW.id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION erase_account_agent_sessions() FROM PUBLIC;

CREATE TRIGGER erase_account_agent_sessions
  AFTER UPDATE OF name ON accounts
  FOR EACH ROW
  WHEN (NEW.name = 'deleted-' || NEW.id::text AND OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION erase_account_agent_sessions();
