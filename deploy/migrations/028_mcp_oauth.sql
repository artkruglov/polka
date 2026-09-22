-- Remote MCP connector: OAuth 2.1 authorization server state for chat clients
-- (Claude.ai, ChatGPT). Access tokens stay agent_connections bearer tokens, so
-- every MCP tool, scope check, audit row and the agents page keep working.
--
-- oauth_clients        Dynamic Client Registration (RFC 7591). Not account data:
--                      a public client has no secret; a confidential one stores
--                      only the secret hash.
-- oauth_authorizations One authorization request from /oauth/authorize. Pending
--                      rows are bound to the browser that started them; approval
--                      binds the owner, granted scopes and a single-use code hash.
--                      A consumed row remembers the connection it produced, so a
--                      replayed code revokes that connection.
-- oauth_refresh_tokens Rotating refresh tokens of one OAuth connection. A rotated
--                      token presented again revokes the whole connection.

CREATE TABLE oauth_clients (
  client_id text PRIMARY KEY CHECK (client_id ~ '^pc_[A-Za-z0-9_-]{22}$'),
  secret_hash text CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  auth_method text NOT NULL CHECK (
    auth_method IN ('none','client_secret_post','client_secret_basic')
  ),
  client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 80),
  redirect_uris text[] NOT NULL CHECK (
    cardinality(redirect_uris) BETWEEN 1 AND 10
    AND array_position(redirect_uris, NULL) IS NULL
  ),
  grant_types text[] NOT NULL CHECK (
    grant_types <@ ARRAY['authorization_code','refresh_token']::text[]
    AND 'authorization_code' = ANY(grant_types)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((auth_method = 'none') = (secret_hash IS NULL))
);
CREATE INDEX oauth_clients_created ON oauth_clients(created_at);

ALTER TABLE agent_connections
  ADD COLUMN oauth_client_id text REFERENCES oauth_clients(client_id),
  ADD COLUMN access_expires_at timestamptz,
  ADD CONSTRAINT agent_connections_oauth_shape CHECK (
    (oauth_client_id IS NULL) = (access_expires_at IS NULL)
  ),
  DROP CONSTRAINT agent_connections_check,
  -- Manual tokens keep the 30-day ceiling. An OAuth connection slides its
  -- 30-day refresh window on use but never outlives one year.
  ADD CONSTRAINT agent_connections_lifetime CHECK (
    expires_at > created_at
    AND expires_at <= created_at + CASE WHEN oauth_client_id IS NULL
      THEN interval '30 days' ELSE interval '365 days' END
  );
CREATE INDEX agent_connections_oauth_client
  ON agent_connections(tenant_id,oauth_client_id)
  WHERE oauth_client_id IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE oauth_authorizations (
  id uuid PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  redirect_uri text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  requested_scopes text[] NOT NULL CHECK (
    cardinality(requested_scopes) BETWEEN 1 AND 7
    AND requested_scopes <@ ARRAY['context','read','source:read','capture','revise','share','manage']::text[]
  ),
  state text CHECK (char_length(state) <= 2048),
  resource text NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','consumed')),
  expires_at timestamptz NOT NULL,
  tenant_id uuid,
  account_id uuid,
  granted_scopes text[] CHECK (
    cardinality(granted_scopes) BETWEEN 1 AND 7
    AND granted_scopes <@ ARRAY['context','read','source:read','capture','revise','share','manage']::text[]
  ),
  code_hash text UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  code_expires_at timestamptz,
  consumed_at timestamptz,
  connection_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,account_id) REFERENCES tenants(id,owner_id),
  FOREIGN KEY(connection_id,tenant_id,account_id)
    REFERENCES agent_connections(id,tenant_id,account_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK (code_expires_at IS NULL OR code_expires_at <= expires_at + interval '60 seconds'),
  CHECK (
    (status IN ('pending','denied') AND account_id IS NULL AND tenant_id IS NULL
      AND granted_scopes IS NULL AND code_hash IS NULL AND code_expires_at IS NULL
      AND consumed_at IS NULL AND connection_id IS NULL)
    OR (status = 'approved' AND account_id IS NOT NULL AND tenant_id IS NOT NULL
      AND granted_scopes IS NOT NULL AND code_hash IS NOT NULL
      AND code_expires_at IS NOT NULL AND consumed_at IS NULL AND connection_id IS NULL)
    OR (status = 'consumed' AND account_id IS NOT NULL AND tenant_id IS NOT NULL
      AND granted_scopes IS NOT NULL AND code_hash IS NOT NULL
      AND code_expires_at IS NOT NULL AND consumed_at IS NOT NULL)
  )
);
CREATE INDEX oauth_authorizations_expiry ON oauth_authorizations(expires_at);
CREATE INDEX oauth_authorizations_tenant ON oauth_authorizations(tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE TABLE oauth_refresh_tokens (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  client_id text NOT NULL REFERENCES oauth_clients(client_id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(connection_id,tenant_id,account_id)
    REFERENCES agent_connections(id,tenant_id,account_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK (rotated_at IS NULL OR rotated_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX oauth_refresh_tokens_connection ON oauth_refresh_tokens(connection_id);
CREATE INDEX oauth_refresh_tokens_tenant ON oauth_refresh_tokens(tenant_id);
CREATE INDEX oauth_refresh_tokens_expiry ON oauth_refresh_tokens(expires_at);

-- Terminal purge also erases the account's OAuth grants. Same body as 023 plus
-- the two OAuth deletes before agent_connections; clients are not account data.
CREATE OR REPLACE FUNCTION terminal_erase_account_metadata(
  p_deletion_id uuid,p_attempt_id uuid,p_password_hash text
) RETURNS public.account_purge_snapshot
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  job public.account_purge_jobs%ROWTYPE;
  publication_count integer;
  metadata_time timestamptz;
  account_email text;
  account_name text;
  name_limit_hash text;
  email_limit_hash text;
BEGIN
  SELECT account.email INTO account_email
    FROM public.account_purge_jobs purge
    JOIN public.accounts account ON account.id=purge.account_id
   WHERE purge.deletion_id=p_deletion_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge job not found'; END IF;
  IF account_email IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(account_email,0));
  END IF;
  job := public.lock_account_purge_job(p_deletion_id,p_attempt_id);
  SELECT account.email,account.name INTO account_email,account_name
    FROM public.accounts account WHERE account.id=job.account_id FOR UPDATE;
  IF job.phase='metadata_purged' THEN
    RETURN ROW(job.deletion_id,job.account_id,job.tenant_id,job.ledger_id,
      job.phase,job.requested_at,job.revoked_at,job.policy_version,
      job.working_data_policy_deadline,job.backup_retention_policy_deadline,
      job.revoke_sha256,job.source_empty_verified_at,
      job.local_mail_cleared_at,job.metadata_purged_at)::public.account_purge_snapshot;
  END IF;
  IF job.phase<>'source_empty' OR job.source_empty_verified_at IS NULL
     OR job.local_mail_cleared_at IS NULL
     OR p_password_hash !~ '^[a-f0-9]{32}:[a-f0-9]{128}$' THEN
    RAISE EXCEPTION 'terminal erasure prerequisites missing';
  END IF;
  name_limit_hash:=encode(pg_catalog.sha256(
    pg_catalog.convert_to('name:'||account_name,'UTF8')),'hex');
  IF account_email IS NOT NULL THEN
    email_limit_hash:=encode(pg_catalog.sha256(
      pg_catalog.convert_to('email-send:'||account_email,'UTF8')),'hex');
  END IF;
  IF EXISTS(SELECT 1 FROM public.login_challenges
            WHERE email=(SELECT email FROM public.accounts WHERE id=job.account_id)) THEN
    RAISE EXCEPTION 'account email challenges remain';
  END IF;
  IF EXISTS(SELECT 1 FROM public.editorial_publications
            WHERE tenant_id=job.tenant_id AND withdrawn_at IS NULL) THEN
    RAISE EXCEPTION 'active editorial publication remains';
  END IF;

  -- Same-library purges serialize before touching membership/publication rows.
  PERFORM library.id FROM public.template_libraries library
   WHERE library.created_by=job.account_id
      OR EXISTS(SELECT 1 FROM public.template_library_members member
                 WHERE member.library_id=library.id AND member.account_id=job.account_id)
      OR EXISTS(SELECT 1 FROM public.template_library_publications publication
                 WHERE publication.library_id=library.id AND publication.publisher_id=job.account_id)
   ORDER BY library.id FOR UPDATE;
  UPDATE public.template_libraries library
     SET state='archived',archived_at=clock_timestamp()
   WHERE library.state='active'
     AND EXISTS(SELECT 1 FROM public.template_library_members member
                 WHERE member.library_id=library.id AND member.account_id=job.account_id
                   AND member.role='admin')
     AND NOT EXISTS(SELECT 1 FROM public.template_library_members member
                     JOIN public.accounts account ON account.id=member.account_id
                    WHERE member.library_id=library.id AND member.account_id<>job.account_id
                      AND member.role='admin' AND member.state='active'
                      AND NOT account.disabled AND account.deletion_requested_at IS NULL);
  DELETE FROM public.template_library_members WHERE account_id=job.account_id;
  UPDATE public.template_libraries SET created_by=NULL WHERE created_by=job.account_id;
  UPDATE public.template_library_publications SET publisher_id=NULL WHERE publisher_id=job.account_id;

  DELETE FROM public.viewer_grants viewer USING public.revisions revision
   WHERE viewer.revision_id=revision.id AND revision.tenant_id=job.tenant_id;
  DELETE FROM public.grants issued USING public.shares share
   WHERE issued.share_id=share.id AND share.tenant_id=job.tenant_id;
  DELETE FROM public.share_reports WHERE tenant_id=job.tenant_id;
  UPDATE public.account_purge_jobs SET terminal_delete_authorized=true
   WHERE deletion_id=job.deletion_id;
  DELETE FROM public.editorial_publications WHERE tenant_id=job.tenant_id;
  GET DIAGNOSTICS publication_count=ROW_COUNT;
  UPDATE public.account_purge_jobs SET terminal_delete_authorized=false
   WHERE deletion_id=job.deletion_id;
  DELETE FROM public.shares WHERE tenant_id=job.tenant_id;
  DELETE FROM public.url_import_jobs WHERE tenant_id=job.tenant_id;
  DELETE FROM public.agent_operations WHERE tenant_id=job.tenant_id;
  DELETE FROM public.audit_outbox WHERE tenant_id=job.tenant_id;
  DELETE FROM public.upload_files file USING public.uploads upload
   WHERE file.upload_id=upload.id AND upload.tenant_id=job.tenant_id;
  DELETE FROM public.uploads WHERE tenant_id=job.tenant_id;
  DELETE FROM public.oauth_refresh_tokens WHERE tenant_id=job.tenant_id;
  DELETE FROM public.oauth_authorizations WHERE tenant_id=job.tenant_id;
  DELETE FROM public.agent_connections WHERE tenant_id=job.tenant_id;
  DELETE FROM public.sessions WHERE account_id=job.account_id;
  DELETE FROM public.login_limits WHERE key=name_limit_hash
    OR (email_limit_hash IS NOT NULL AND key=email_limit_hash);
  UPDATE public.artifacts SET latest_revision_id=NULL WHERE tenant_id=job.tenant_id;
  DELETE FROM public.revision_files file USING public.revisions revision
   WHERE file.revision_id=revision.id AND revision.tenant_id=job.tenant_id;
  DELETE FROM public.revision_derivatives WHERE tenant_id=job.tenant_id;
  DELETE FROM public.revisions WHERE tenant_id=job.tenant_id;
  DELETE FROM public.artifacts WHERE tenant_id=job.tenant_id;
  DELETE FROM public.folders WHERE tenant_id=job.tenant_id;

  UPDATE public.tenants SET used_bytes=0,derivative_used_bytes=0
   WHERE id=job.tenant_id;
  UPDATE public.accounts SET email=NULL,email_verified_at=NULL,display_name=NULL,
    name='deleted-'||id::text,password_hash=p_password_hash
   WHERE id=job.account_id;
  metadata_time:=clock_timestamp();
  UPDATE public.account_purge_jobs SET phase='metadata_purged',
    metadata_purged_at=metadata_time,deleted_publications=publication_count,
    retry_at=metadata_time,
    updated_at=metadata_time WHERE deletion_id=job.deletion_id
   RETURNING * INTO job;
  RETURN ROW(job.deletion_id,job.account_id,job.tenant_id,job.ledger_id,
    job.phase,job.requested_at,job.revoked_at,job.policy_version,
    job.working_data_policy_deadline,job.backup_retention_policy_deadline,
    job.revoke_sha256,job.source_empty_verified_at,
    job.local_mail_cleared_at,job.metadata_purged_at)::public.account_purge_snapshot;
END $$;
