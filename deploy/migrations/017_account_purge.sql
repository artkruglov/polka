CREATE TABLE account_purge_jobs (
  deletion_id uuid PRIMARY KEY REFERENCES account_deletions(id),
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
  tenant_id uuid NOT NULL UNIQUE,
  ledger_id uuid,
  phase text NOT NULL CHECK (phase IN (
    'awaiting_revoke_ledger','deleting_source','source_empty',
    'metadata_purged','purged'
  )),
  requested_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL,
  policy_version text NOT NULL CHECK (
    char_length(policy_version) BETWEEN 1 AND 80
    AND policy_version ~ '^[A-Za-z0-9._-]+$'
  ),
  working_data_policy_deadline timestamptz NOT NULL,
  backup_retention_policy_deadline timestamptz NOT NULL,
  attempt_id uuid,
  attempt_expires_at timestamptz,
  retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code text CHECK (
    error_code IS NULL OR error_code IN ('storage','database','ledger','mail','internal')
  ),
  revoke_key text,
  revoke_sha256 text CHECK (revoke_sha256 IS NULL OR revoke_sha256 ~ '^[a-f0-9]{64}$'),
  revoke_version text,
  source_empty_verified_at timestamptz,
  local_mail_cleared_at timestamptz,
  metadata_purged_at timestamptz,
  deleted_publications integer CHECK (deleted_publications IS NULL OR deleted_publications >= 0),
  purged_key text,
  purged_sha256 text CHECK (purged_sha256 IS NULL OR purged_sha256 ~ '^[a-f0-9]{64}$'),
  purged_version text,
  terminal_delete_authorized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,account_id) REFERENCES tenants(id,owner_id),
  CHECK (requested_at <= revoked_at),
  CHECK (working_data_policy_deadline >= requested_at),
  CHECK (backup_retention_policy_deadline >= requested_at),
  CHECK ((attempt_id IS NULL) = (attempt_expires_at IS NULL)),
  CHECK (
    (revoke_key IS NULL AND revoke_sha256 IS NULL AND revoke_version IS NULL)
    OR
    (revoke_key IS NOT NULL AND revoke_sha256 IS NOT NULL AND revoke_version IS NOT NULL)
  ),
  CHECK (
    (purged_key IS NULL AND purged_sha256 IS NULL AND purged_version IS NULL)
    OR
    (purged_key IS NOT NULL AND purged_sha256 IS NOT NULL AND purged_version IS NOT NULL)
  ),
  CHECK (phase='awaiting_revoke_ledger' OR revoke_key IS NOT NULL),
  CHECK (phase NOT IN ('source_empty','metadata_purged','purged') OR source_empty_verified_at IS NOT NULL),
  CHECK (phase NOT IN ('metadata_purged','purged') OR (
    local_mail_cleared_at IS NOT NULL AND metadata_purged_at IS NOT NULL
  )),
  CHECK (phase<>'purged' OR purged_key IS NOT NULL)
);

CREATE INDEX account_purge_jobs_due
  ON account_purge_jobs(retry_at,deletion_id)
  WHERE phase<>'purged';

CREATE FUNCTION enqueue_account_purge_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state='access_revoked_pending_purge'
     AND OLD.state='planned' THEN
    INSERT INTO public.account_purge_jobs(
      deletion_id,account_id,tenant_id,phase,requested_at,revoked_at,
      policy_version,working_data_policy_deadline,
      backup_retention_policy_deadline
    ) VALUES(
      NEW.id,NEW.account_id,NEW.tenant_id,'awaiting_revoke_ledger',
      NEW.requested_at,NEW.revoked_at,NEW.policy_version,
      NEW.working_data_policy_deadline,NEW.backup_retention_policy_deadline
    );
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER account_deletion_enqueue_purge
  AFTER UPDATE OF state ON account_deletions
  FOR EACH ROW EXECUTE FUNCTION enqueue_account_purge_job();

INSERT INTO account_purge_jobs(
  deletion_id,account_id,tenant_id,phase,requested_at,revoked_at,
  policy_version,working_data_policy_deadline,backup_retention_policy_deadline
)
SELECT id,account_id,tenant_id,'awaiting_revoke_ledger',requested_at,revoked_at,
       policy_version,working_data_policy_deadline,backup_retention_policy_deadline
FROM account_deletions
WHERE state IN ('access_revoked_pending_purge','failed');

DO $$
DECLARE shape_constraint text;
BEGIN
  SELECT conname INTO shape_constraint
    FROM pg_constraint
   WHERE conrelid='public.account_deletions'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%confirmation_session_hash%purged_at%';
  IF shape_constraint IS NULL THEN
    RAISE EXCEPTION 'account deletion shape constraint not found';
  END IF;
  EXECUTE format('ALTER TABLE public.account_deletions DROP CONSTRAINT %I',shape_constraint);
END $$;

ALTER TABLE account_deletions ADD CONSTRAINT account_deletions_terminal_shape CHECK (
  (state='planned' AND requested_at IS NULL AND revoked_at IS NULL
    AND working_data_policy_deadline IS NULL
    AND backup_retention_policy_deadline IS NULL
    AND confirmation_session_hash IS NULL AND purged_at IS NULL)
  OR
  (state IN ('access_revoked_pending_purge','failed')
    AND requested_at IS NOT NULL AND revoked_at IS NOT NULL
    AND working_data_policy_deadline IS NOT NULL
    AND backup_retention_policy_deadline IS NOT NULL
    AND confirmation_session_hash IS NOT NULL AND purged_at IS NULL)
  OR
  (state='purged' AND requested_at IS NOT NULL AND revoked_at IS NOT NULL
    AND working_data_policy_deadline IS NOT NULL
    AND backup_retention_policy_deadline IS NOT NULL
    AND confirmation_session_hash IS NULL AND purged_at IS NOT NULL)
);

CREATE TYPE account_purge_snapshot AS (
  deletion_id uuid,
  account_id uuid,
  tenant_id uuid,
  ledger_id uuid,
  phase text,
  requested_at timestamptz,
  revoked_at timestamptz,
  policy_version text,
  working_data_policy_deadline timestamptz,
  backup_retention_policy_deadline timestamptz,
  revoke_sha256 text,
  source_empty_verified_at timestamptz,
  local_mail_cleared_at timestamptz,
  metadata_purged_at timestamptz
);

CREATE TYPE account_purge_mail_snapshot AS (
  account_email text,
  challenges jsonb
);

CREATE FUNCTION claim_account_purge_job(p_attempt_id uuid, p_ledger_id uuid)
RETURNS public.account_purge_snapshot
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  candidate public.account_purge_jobs%ROWTYPE;
  locked_job public.account_purge_jobs%ROWTYPE;
BEGIN
  IF p_attempt_id IS NULL OR p_ledger_id IS NULL THEN
    RAISE EXCEPTION 'purge attempt and ledger are required';
  END IF;
  SELECT * INTO candidate FROM public.account_purge_jobs
   WHERE phase IN ('awaiting_revoke_ledger','deleting_source','source_empty','metadata_purged')
     AND retry_at<=clock_timestamp()
     AND (attempt_expires_at IS NULL OR attempt_expires_at<clock_timestamp())
   ORDER BY retry_at,deletion_id LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM 1 FROM public.tenants WHERE id=candidate.tenant_id FOR UPDATE;
  PERFORM 1 FROM public.accounts WHERE id=candidate.account_id FOR UPDATE;
  PERFORM 1 FROM public.account_deletions WHERE id=candidate.deletion_id FOR UPDATE;
  SELECT * INTO locked_job FROM public.account_purge_jobs
   WHERE deletion_id=candidate.deletion_id FOR UPDATE;
  IF locked_job.phase='purged' OR locked_job.retry_at>clock_timestamp()
     OR (locked_job.attempt_expires_at IS NOT NULL
         AND locked_job.attempt_expires_at>=clock_timestamp()) THEN
    RETURN NULL;
  END IF;
  IF locked_job.ledger_id IS NOT NULL AND locked_job.ledger_id<>p_ledger_id THEN
    RAISE EXCEPTION 'purge ledger namespace mismatch';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.accounts account
    JOIN public.tenants tenant ON tenant.owner_id=account.id
    JOIN public.account_deletions deletion
      ON deletion.account_id=account.id AND deletion.tenant_id=tenant.id
    WHERE account.id=locked_job.account_id
      AND tenant.id=locked_job.tenant_id
      AND deletion.id=locked_job.deletion_id
      AND account.disabled AND account.deletion_requested_at IS NOT NULL
      AND deletion.state IN ('access_revoked_pending_purge','failed')
  ) THEN
    RAISE EXCEPTION 'purge owner is not revoked';
  END IF;
  UPDATE public.account_purge_jobs SET
    ledger_id=COALESCE(ledger_id,p_ledger_id),attempt_id=p_attempt_id,
    attempt_expires_at=clock_timestamp()+interval '10 minutes',
    attempt_count=attempt_count+1,error_code=NULL,updated_at=clock_timestamp()
   WHERE deletion_id=locked_job.deletion_id
   RETURNING * INTO locked_job;
  RETURN ROW(
    locked_job.deletion_id,locked_job.account_id,locked_job.tenant_id,
    locked_job.ledger_id,locked_job.phase,locked_job.requested_at,
    locked_job.revoked_at,locked_job.policy_version,
    locked_job.working_data_policy_deadline,
    locked_job.backup_retention_policy_deadline,locked_job.revoke_sha256,
    locked_job.source_empty_verified_at,locked_job.local_mail_cleared_at,
    locked_job.metadata_purged_at
  )::public.account_purge_snapshot;
END $$;

CREATE FUNCTION lock_account_purge_job(p_deletion_id uuid, p_attempt_id uuid)
RETURNS public.account_purge_jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.account_purge_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job FROM public.account_purge_jobs WHERE deletion_id=p_deletion_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge job not found'; END IF;
  PERFORM 1 FROM public.tenants WHERE id=job.tenant_id FOR UPDATE;
  PERFORM 1 FROM public.accounts WHERE id=job.account_id FOR UPDATE;
  PERFORM 1 FROM public.account_deletions WHERE id=job.deletion_id FOR UPDATE;
  SELECT * INTO job FROM public.account_purge_jobs WHERE deletion_id=p_deletion_id FOR UPDATE;
  IF job.attempt_id IS DISTINCT FROM p_attempt_id
     OR job.attempt_expires_at IS NULL
     OR job.attempt_expires_at<clock_timestamp() THEN
    RAISE EXCEPTION 'stale purge attempt';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.accounts account
    JOIN public.account_deletions deletion ON deletion.account_id=account.id
    WHERE account.id=job.account_id AND deletion.id=job.deletion_id
      AND account.disabled AND account.deletion_requested_at IS NOT NULL
      AND deletion.state IN ('access_revoked_pending_purge','failed')
  ) THEN
    RAISE EXCEPTION 'purge owner is not revoked';
  END IF;
  RETURN job;
END $$;

CREATE FUNCTION acknowledge_account_purge_revoke(
  p_deletion_id uuid,p_attempt_id uuid,p_key text,p_sha256 text,p_version text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.account_purge_jobs%ROWTYPE;
BEGIN
  job := public.lock_account_purge_job(p_deletion_id,p_attempt_id);
  IF job.phase<>'awaiting_revoke_ledger' THEN
    IF job.revoke_key=p_key AND job.revoke_sha256=p_sha256 AND job.revoke_version=p_version THEN RETURN; END IF;
    RAISE EXCEPTION 'invalid revoke acknowledgement phase';
  END IF;
  IF p_key<>format('erasure/v1/%s/%s/revoke.json',job.ledger_id,job.deletion_id)
     OR p_sha256 !~ '^[a-f0-9]{64}$' OR NULLIF(p_version,'') IS NULL
     OR p_version='null' THEN
    RAISE EXCEPTION 'invalid revoke acknowledgement';
  END IF;
  UPDATE public.account_purge_jobs SET phase='deleting_source',revoke_key=p_key,
    revoke_sha256=p_sha256,revoke_version=p_version,retry_at=clock_timestamp(),
    updated_at=clock_timestamp() WHERE deletion_id=p_deletion_id;
END $$;

CREATE FUNCTION mark_account_purge_source_empty(
  p_deletion_id uuid,p_attempt_id uuid,p_verified_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.account_purge_jobs%ROWTYPE;
BEGIN
  job := public.lock_account_purge_job(p_deletion_id,p_attempt_id);
  IF job.phase='source_empty' AND job.source_empty_verified_at=p_verified_at THEN RETURN; END IF;
  IF job.phase<>'deleting_source' OR p_verified_at<job.revoked_at THEN
    RAISE EXCEPTION 'invalid source-empty transition';
  END IF;
  UPDATE public.account_purge_jobs SET phase='source_empty',
    source_empty_verified_at=p_verified_at,retry_at=clock_timestamp(),
    updated_at=clock_timestamp() WHERE deletion_id=p_deletion_id;
END $$;

CREATE FUNCTION yield_account_purge_attempt(
  p_deletion_id uuid,p_attempt_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.account_purge_jobs%ROWTYPE;
BEGIN
  job := public.lock_account_purge_job(p_deletion_id,p_attempt_id);
  IF job.phase<>'deleting_source' THEN
    RAISE EXCEPTION 'only a source-deletion batch may yield';
  END IF;
  UPDATE public.account_purge_jobs SET attempt_id=NULL,attempt_expires_at=NULL,
    retry_at=clock_timestamp(),error_code=NULL,updated_at=clock_timestamp()
   WHERE deletion_id=p_deletion_id;
END $$;

CREATE FUNCTION lock_account_purge_mail(
  p_deletion_id uuid,p_attempt_id uuid
) RETURNS public.account_purge_mail_snapshot
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  account_email text;
  job public.account_purge_jobs%ROWTYPE;
  challenges jsonb;
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
  IF job.phase<>'source_empty' THEN RAISE EXCEPTION 'source is not empty'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',locked.id,'delivery',locked.delivery
         ) ORDER BY locked.created_at,locked.id),'[]'::jsonb)
    INTO challenges
    FROM (
      SELECT challenge.id,challenge.delivery,challenge.created_at
        FROM public.login_challenges challenge
       WHERE account_email IS NOT NULL AND challenge.email=account_email
       ORDER BY challenge.created_at,challenge.id
       FOR UPDATE SKIP LOCKED
    ) locked;
  RETURN ROW(account_email,challenges)::public.account_purge_mail_snapshot;
END $$;

CREATE FUNCTION complete_account_purge_mail(
  p_deletion_id uuid,p_attempt_id uuid,p_cleared_at timestamptz,
  p_challenge_ids uuid[]
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  account_email text;
  job public.account_purge_jobs%ROWTYPE;
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
  IF job.phase<>'source_empty' OR p_cleared_at<job.revoked_at THEN
    RAISE EXCEPTION 'invalid local-mail transition';
  END IF;
  IF p_challenge_ids IS NULL THEN
    RAISE EXCEPTION 'challenge inventory is required';
  END IF;
  IF EXISTS(
    SELECT 1 FROM unnest(p_challenge_ids) supplied(id)
     LEFT JOIN public.login_challenges challenge
       ON challenge.id=supplied.id AND challenge.email=account_email
    WHERE challenge.id IS NULL
  ) THEN RAISE EXCEPTION 'challenge inventory changed'; END IF;
  DELETE FROM public.login_challenges challenge
   WHERE challenge.email=account_email AND challenge.id=ANY(p_challenge_ids);
  IF account_email IS NOT NULL AND EXISTS(
    SELECT 1 FROM public.login_challenges WHERE email=account_email
  ) THEN RAISE EXCEPTION 'account email challenges are busy'; END IF;
  IF job.local_mail_cleared_at IS NOT NULL
     AND job.local_mail_cleared_at<>p_cleared_at THEN
    RAISE EXCEPTION 'local-mail proof is immutable';
  END IF;
  UPDATE public.account_purge_jobs SET local_mail_cleared_at=p_cleared_at,
    retry_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE deletion_id=p_deletion_id AND local_mail_cleared_at IS NULL;
END $$;

CREATE FUNCTION terminal_erase_account_metadata(
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
  DELETE FROM public.agent_operations WHERE tenant_id=job.tenant_id;
  DELETE FROM public.audit_outbox WHERE tenant_id=job.tenant_id;
  DELETE FROM public.upload_files file USING public.uploads upload
   WHERE file.upload_id=upload.id AND upload.tenant_id=job.tenant_id;
  DELETE FROM public.uploads WHERE tenant_id=job.tenant_id;
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

CREATE FUNCTION acknowledge_account_purge_terminal(
  p_deletion_id uuid,p_attempt_id uuid,p_key text,p_sha256 text,p_version text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.account_purge_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job FROM public.account_purge_jobs WHERE deletion_id=p_deletion_id;
  IF job.phase='purged' THEN
    IF job.purged_key=p_key AND job.purged_sha256=p_sha256
       AND job.purged_version=p_version THEN RETURN; END IF;
    RAISE EXCEPTION 'conflicting terminal acknowledgement';
  END IF;
  job := public.lock_account_purge_job(p_deletion_id,p_attempt_id);
  IF job.phase<>'metadata_purged' THEN
    RAISE EXCEPTION 'invalid terminal acknowledgement phase';
  END IF;
  IF p_key<>format('erasure/v1/%s/%s/purged.json',job.ledger_id,job.deletion_id)
     OR p_sha256 !~ '^[a-f0-9]{64}$' OR NULLIF(p_version,'') IS NULL
     OR p_version='null' THEN
    RAISE EXCEPTION 'invalid terminal acknowledgement';
  END IF;
  UPDATE public.account_purge_jobs SET phase='purged',purged_key=p_key,
    purged_sha256=p_sha256,purged_version=p_version,attempt_id=NULL,
    attempt_expires_at=NULL,error_code=NULL,retry_at=clock_timestamp(),
    updated_at=clock_timestamp() WHERE deletion_id=p_deletion_id;
  UPDATE public.account_deletions SET state='purged',purged_at=clock_timestamp(),
    retry_at=NULL,error_code=NULL,confirmation_session_hash=NULL,
    artifact_count=0,revision_count=0,source_bytes=0,derivative_bytes=0
   WHERE id=p_deletion_id;
END $$;

CREATE FUNCTION fail_account_purge_attempt(
  p_deletion_id uuid,p_attempt_id uuid,p_error_code text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.account_purge_jobs%ROWTYPE;
BEGIN
  job := public.lock_account_purge_job(p_deletion_id,p_attempt_id);
  IF p_error_code NOT IN ('storage','database','ledger','mail','internal') THEN
    RAISE EXCEPTION 'invalid purge error code';
  END IF;
  UPDATE public.account_purge_jobs SET attempt_id=NULL,attempt_expires_at=NULL,
    retry_at=clock_timestamp()+interval '5 minutes',error_code=p_error_code,
    terminal_delete_authorized=false,updated_at=clock_timestamp()
   WHERE deletion_id=p_deletion_id;
  UPDATE public.account_deletions SET retry_at=clock_timestamp()+interval '5 minutes',
    error_code=CASE WHEN p_error_code='mail' THEN 'internal' ELSE p_error_code END
   WHERE id=p_deletion_id AND state<>'purged';
END $$;

CREATE OR REPLACE FUNCTION preserve_editorial_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(
      SELECT 1 FROM public.account_purge_jobs job
       WHERE job.tenant_id=OLD.tenant_id
         AND job.terminal_delete_authorized
         AND job.phase='source_empty'
    ) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'editorial publication rows are immutable';
  END IF;
  IF NOT (
    OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL
    AND NEW.id=OLD.id AND NEW.slug=OLD.slug
    AND NEW.tenant_id=OLD.tenant_id AND NEW.artifact_id=OLD.artifact_id
    AND NEW.revision_id=OLD.revision_id AND NEW.share_id=OLD.share_id
    AND NEW.derivative_id IS NOT DISTINCT FROM OLD.derivative_id
    AND NEW.source_sha256=OLD.source_sha256
    AND NEW.manifest_sha256 IS NOT DISTINCT FROM OLD.manifest_sha256
    AND NEW.derivative_sha256 IS NOT DISTINCT FROM OLD.derivative_sha256
    AND NEW.builder_version IS NOT DISTINCT FROM OLD.builder_version
    AND NEW.runtime_profile IS NOT DISTINCT FROM OLD.runtime_profile
    AND NEW.metadata=OLD.metadata AND NEW.request=OLD.request
    AND NEW.request_hash=OLD.request_hash AND NEW.published_at=OLD.published_at
  ) THEN RAISE EXCEPTION 'editorial publication rows are immutable'; END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON TABLE account_purge_jobs FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION enqueue_account_purge_job() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_account_purge_job(uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lock_account_purge_job(uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION acknowledge_account_purge_revoke(uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_account_purge_source_empty(uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION yield_account_purge_attempt(uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lock_account_purge_mail(uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_account_purge_mail(uuid,uuid,timestamptz,uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION terminal_erase_account_metadata(uuid,uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION acknowledge_account_purge_terminal(uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fail_account_purge_attempt(uuid,uuid,text) FROM PUBLIC;
