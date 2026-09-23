-- Comments and reactions on the text of a shared work
-- (docs/specs/COMMENTS.md, stage 3).
--
-- comments           A thread belongs to one link (share): recipients of one
--                    link never see another link's threads; the owner sees
--                    all of them. anchor is a W3C text quote
--                    {exact,prefix,suffix} or NULL (the whole work); the
--                    server stores the quote only, the viewer re-finds it.
--                    Replies are one level deep (parent_id is a root of the
--                    same share). body is plain text, never rendered as HTML.
--                    signals are the phishing signals of the body (as for
--                    pages); held_at hides a suspicious comment of an
--                    untrusted author from everyone but its author and the
--                    owner until the operator releases it. deleted_at empties
--                    the body; the row stays while replies need a parent.
-- comment_reactions  A fixed set of emoji on a fragment (anchor_sig is the
--                    SHA-256 of prefix|exact|suffix) or on the whole work
--                    (anchor_sig ''). One per author, link, fragment, emoji:
--                    pressing it again removes it.
-- share_reports.comment_id  A report about one comment of the link rather
--                    than the page; it never pauses the link.
-- artifacts.comments_seen_at  When the owner last read the work's threads
--                    (the unread counter).
-- agent_operations   'share-move': an agent points an existing link at a
--                    newer version, so its discussion moves along.
-- viewer_grants.comments  The embedding shell asked for the comment overlay.
--                    Only such a grant gets the script; downloads and other
--                    views stay byte-exact.

ALTER TABLE shares ADD CONSTRAINT shares_scope UNIQUE (tenant_id, artifact_id, id);

CREATE TABLE comments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  share_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  author_account_id uuid NOT NULL REFERENCES accounts,
  parent_id uuid,
  anchor jsonb CHECK (anchor IS NULL OR (jsonb_typeof(anchor)='object'
    AND jsonb_typeof(anchor->'exact')='string'
    AND octet_length(anchor::text) <= 8192)),
  body text NOT NULL CHECK (char_length(body) <= 2000),
  signals text[] NOT NULL DEFAULT '{}' CHECK (cardinality(signals) <= 64),
  held_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES accounts,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (share_id, id),
  FOREIGN KEY (tenant_id, artifact_id, share_id)
    REFERENCES shares(tenant_id, artifact_id, id),
  FOREIGN KEY (tenant_id, artifact_id, revision_id)
    REFERENCES revisions(tenant_id, artifact_id, id),
  FOREIGN KEY (share_id, parent_id) REFERENCES comments(share_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (parent_id IS NULL OR anchor IS NULL),
  CHECK (deleted_at IS NULL OR body = '')
);
CREATE INDEX comments_share ON comments(share_id, created_at);
CREATE INDEX comments_artifact ON comments(tenant_id, artifact_id, created_at);
CREATE INDEX comments_author ON comments(author_account_id, created_at);
CREATE INDEX comments_parent ON comments(parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE comment_reactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  share_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  author_account_id uuid NOT NULL REFERENCES accounts,
  anchor_sig text NOT NULL CHECK (anchor_sig = '' OR anchor_sig ~ '^[a-f0-9]{64}$'),
  anchor jsonb CHECK (anchor IS NULL OR (jsonb_typeof(anchor)='object'
    AND octet_length(anchor::text) <= 8192)),
  emoji text NOT NULL CHECK (emoji IN (
    U&'\+01F44D', U&'\+01F44E', U&'\+01F389', U&'\+01F914',
    U&'\2764\FE0F', U&'\+01F440', U&'\2705')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (share_id, author_account_id, anchor_sig, emoji),
  FOREIGN KEY (tenant_id, artifact_id, share_id)
    REFERENCES shares(tenant_id, artifact_id, id),
  FOREIGN KEY (tenant_id, artifact_id, revision_id)
    REFERENCES revisions(tenant_id, artifact_id, id),
  CHECK ((anchor_sig = '') = (anchor IS NULL))
);
CREATE INDEX comment_reactions_share ON comment_reactions(share_id);
CREATE INDEX comment_reactions_author ON comment_reactions(author_account_id, created_at);
CREATE INDEX comment_reactions_artifact ON comment_reactions(tenant_id, artifact_id);

ALTER TABLE share_reports
  ADD COLUMN comment_id uuid REFERENCES comments ON DELETE CASCADE;
-- An agent moves an existing link to a newer version (polka_share with
-- moveShareId): the link, its token and its discussion stay.
ALTER TABLE agent_operations
  DROP CONSTRAINT agent_operations_operation_check,
  ADD CONSTRAINT agent_operations_operation_check
    CHECK(operation IN ('share','metadata','share-move'));
ALTER TABLE artifacts ADD COLUMN comments_seen_at timestamptz;
ALTER TABLE viewer_grants ADD COLUMN comments boolean NOT NULL DEFAULT false;

-- Terminal purge also erases comments and reactions. Same body as 028 plus
-- the comment statements before viewer grants.
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

  -- Comments and reactions (030): everything on this shelf's links, and what
  -- the account wrote on other shelves. A root another person answered keeps
  -- its place in that thread, emptied and marked deleted.
  DELETE FROM public.comment_reactions
   WHERE tenant_id=job.tenant_id OR author_account_id=job.account_id;
  DELETE FROM public.comments WHERE tenant_id=job.tenant_id;
  DELETE FROM public.comments WHERE author_account_id=job.account_id
    AND parent_id IS NOT NULL;
  DELETE FROM public.comments root WHERE root.author_account_id=job.account_id
    AND NOT EXISTS(SELECT 1 FROM public.comments reply WHERE reply.parent_id=root.id);
  UPDATE public.comments SET body='',signals='{}',held_at=NULL,
    deleted_at=COALESCE(deleted_at,clock_timestamp())
   WHERE author_account_id=job.account_id;
  UPDATE public.comments SET resolved_by=NULL WHERE resolved_by=job.account_id;
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
