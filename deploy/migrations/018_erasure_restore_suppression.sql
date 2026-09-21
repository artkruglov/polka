CREATE TABLE account_restore_suppressions (
  restore_run_id uuid NOT NULL,
  deletion_id uuid NOT NULL,
  account_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  ledger_id uuid NOT NULL,
  ledger_state text NOT NULL CHECK (ledger_state IN ('revoked','purged')),
  metadata_present boolean NOT NULL,
  state text NOT NULL CHECK (state IN ('registered','completed')),
  requested_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL,
  policy_version text NOT NULL CHECK (
    char_length(policy_version) BETWEEN 1 AND 80
    AND policy_version ~ '^[A-Za-z0-9._-]+$'
  ),
  working_data_policy_deadline timestamptz NOT NULL,
  backup_retention_policy_deadline timestamptz NOT NULL,
  revoke_key text NOT NULL,
  revoke_sha256 text NOT NULL CHECK (revoke_sha256 ~ '^[a-f0-9]{64}$'),
  revoke_version text NOT NULL CHECK (revoke_version<>'' AND revoke_version<>'null'),
  purged_key text,
  purged_sha256 text CHECK (purged_sha256 IS NULL OR purged_sha256 ~ '^[a-f0-9]{64}$'),
  purged_version text,
  original_source_empty_at timestamptz,
  original_local_mail_cleared_at timestamptz,
  original_metadata_purged_at timestamptz,
  local_source_empty_at timestamptz,
  local_metadata_purged_at timestamptz,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY(restore_run_id,deletion_id),
  UNIQUE(restore_run_id,account_id),
  UNIQUE(restore_run_id,tenant_id),
  CHECK (
    (ledger_state='revoked' AND purged_key IS NULL AND purged_sha256 IS NULL
      AND purged_version IS NULL AND original_source_empty_at IS NULL
      AND original_local_mail_cleared_at IS NULL
      AND original_metadata_purged_at IS NULL)
    OR
    (ledger_state='purged' AND purged_key IS NOT NULL AND purged_sha256 IS NOT NULL
      AND purged_version IS NOT NULL AND purged_version<>'' AND purged_version<>'null'
      AND original_source_empty_at IS NOT NULL
      AND original_local_mail_cleared_at IS NOT NULL
      AND original_metadata_purged_at IS NOT NULL)
  ),
  CHECK (
    (state='registered' AND completed_at IS NULL)
    OR (state='completed' AND completed_at IS NOT NULL)
  ),
  CHECK (requested_at<=revoked_at),
  CHECK (working_data_policy_deadline>=requested_at),
  CHECK (backup_retention_policy_deadline>=requested_at)
);

ALTER TABLE account_purge_jobs DROP CONSTRAINT account_purge_jobs_phase_check;
ALTER TABLE account_purge_jobs ADD CONSTRAINT account_purge_jobs_phase_check
  CHECK (phase IN (
    'awaiting_revoke_ledger','deleting_source','source_empty',
    'metadata_purged','purged','restore_suppressed'
  ));

DROP INDEX account_purge_jobs_due;
CREATE INDEX account_purge_jobs_due
  ON account_purge_jobs(retry_at,deletion_id)
  WHERE phase IN (
    'awaiting_revoke_ledger','deleting_source','source_empty','metadata_purged'
  );

-- Restore reconciliation is a separate privileged invocation. Ordinary purge
-- claims must never append a new ledger record for a job bound to an immutable
-- historic ledger entry.
CREATE OR REPLACE FUNCTION claim_account_purge_job(
  p_attempt_id uuid,p_ledger_id uuid
) RETURNS public.account_purge_snapshot
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  candidate public.account_purge_jobs%ROWTYPE;
  locked_job public.account_purge_jobs%ROWTYPE;
BEGIN
  IF p_attempt_id IS NULL OR p_ledger_id IS NULL THEN
    RAISE EXCEPTION 'purge attempt and ledger are required';
  END IF;
  SELECT purge.* INTO candidate FROM public.account_purge_jobs purge
   WHERE purge.phase IN (
     'awaiting_revoke_ledger','deleting_source','source_empty','metadata_purged'
   )
     AND purge.retry_at<=clock_timestamp()
     AND (purge.attempt_expires_at IS NULL
          OR purge.attempt_expires_at<clock_timestamp())
     AND NOT EXISTS(
       SELECT 1 FROM public.account_restore_suppressions suppression
        WHERE suppression.deletion_id=purge.deletion_id
          AND suppression.state='registered'
     )
   ORDER BY purge.retry_at,purge.deletion_id LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM 1 FROM public.tenants WHERE id=candidate.tenant_id FOR UPDATE;
  PERFORM 1 FROM public.accounts WHERE id=candidate.account_id FOR UPDATE;
  PERFORM 1 FROM public.account_deletions
   WHERE id=candidate.deletion_id FOR UPDATE;
  SELECT * INTO locked_job FROM public.account_purge_jobs
   WHERE deletion_id=candidate.deletion_id FOR UPDATE;
  IF locked_job.phase NOT IN (
       'awaiting_revoke_ledger','deleting_source','source_empty','metadata_purged'
     )
     OR locked_job.retry_at>clock_timestamp()
     OR (locked_job.attempt_expires_at IS NOT NULL
         AND locked_job.attempt_expires_at>=clock_timestamp())
     OR EXISTS(
       SELECT 1 FROM public.account_restore_suppressions suppression
        WHERE suppression.deletion_id=locked_job.deletion_id
          AND suppression.state='registered'
     ) THEN
    RETURN NULL;
  END IF;
  IF locked_job.ledger_id IS NOT NULL
     AND locked_job.ledger_id<>p_ledger_id THEN
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

CREATE FUNCTION register_restored_erasure(
  p_restore_run_id uuid,p_deletion_id uuid,p_account_id uuid,p_tenant_id uuid,
  p_ledger_id uuid,p_ledger_state text,p_requested_at timestamptz,
  p_revoked_at timestamptz,p_policy_version text,
  p_working_deadline timestamptz,p_backup_deadline timestamptz,
  p_revoke_key text,p_revoke_sha256 text,p_revoke_version text,
  p_purged_key text,p_purged_sha256 text,p_purged_version text,
  p_original_source_empty_at timestamptz,
  p_original_local_mail_cleared_at timestamptz,
  p_original_metadata_purged_at timestamptz,
  p_status_capability_hash text,p_confirmation_hash text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  account_row public.accounts%ROWTYPE;
  tenant_row public.tenants%ROWTYPE;
  deletion_row public.account_deletions%ROWTYPE;
  existing public.account_restore_suppressions%ROWTYPE;
  artifact_total integer;
  revision_total integer;
  purge_hours integer;
  backup_days integer;
BEGIN
  IF p_restore_run_id IS NULL OR p_deletion_id IS NULL OR p_account_id IS NULL
     OR p_tenant_id IS NULL OR p_ledger_id IS NULL
     OR p_ledger_state IS NULL OR p_requested_at IS NULL
     OR p_revoked_at IS NULL OR p_policy_version IS NULL
     OR p_working_deadline IS NULL OR p_backup_deadline IS NULL
     OR p_revoke_key IS NULL OR p_revoke_sha256 IS NULL
     OR p_revoke_version IS NULL OR p_status_capability_hash IS NULL
     OR p_confirmation_hash IS NULL
     OR p_requested_at>p_revoked_at OR p_working_deadline<p_requested_at
     OR p_backup_deadline<p_requested_at
     OR p_policy_version !~ '^[A-Za-z0-9._-]{1,80}$'
     OR p_revoke_key<>format('erasure/v1/%s/%s/revoke.json',p_ledger_id,p_deletion_id)
     OR p_revoke_sha256 !~ '^[a-f0-9]{64}$'
     OR NULLIF(p_revoke_version,'') IS NULL OR p_revoke_version='null'
     OR p_status_capability_hash !~ '^[a-f0-9]{64}$'
     OR p_confirmation_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid restore erasure registration';
  END IF;
  IF p_ledger_state='purged' THEN
    IF p_purged_key IS NULL OR p_purged_sha256 IS NULL
       OR p_purged_version IS NULL
       OR p_purged_key<>format('erasure/v1/%s/%s/purged.json',p_ledger_id,p_deletion_id)
       OR p_purged_sha256 !~ '^[a-f0-9]{64}$'
       OR NULLIF(p_purged_version,'') IS NULL OR p_purged_version='null'
       OR p_original_source_empty_at IS NULL
       OR p_original_local_mail_cleared_at IS NULL
       OR p_original_metadata_purged_at IS NULL THEN
      RAISE EXCEPTION 'invalid historic purged registration';
    END IF;
  ELSIF p_ledger_state='revoked' THEN
    IF p_purged_key IS NOT NULL OR p_purged_sha256 IS NOT NULL
       OR p_purged_version IS NOT NULL OR p_original_source_empty_at IS NOT NULL
       OR p_original_local_mail_cleared_at IS NOT NULL
       OR p_original_metadata_purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'invalid historic revoked registration';
    END IF;
  ELSE RAISE EXCEPTION 'invalid historic ledger state'; END IF;

  SELECT * INTO existing FROM public.account_restore_suppressions
   WHERE restore_run_id=p_restore_run_id AND deletion_id=p_deletion_id;
  IF FOUND THEN
    IF existing.account_id IS DISTINCT FROM p_account_id
       OR existing.tenant_id IS DISTINCT FROM p_tenant_id
       OR existing.ledger_id IS DISTINCT FROM p_ledger_id
       OR existing.ledger_state IS DISTINCT FROM p_ledger_state
       OR existing.requested_at IS DISTINCT FROM p_requested_at
       OR existing.revoked_at IS DISTINCT FROM p_revoked_at
       OR existing.policy_version IS DISTINCT FROM p_policy_version
       OR existing.working_data_policy_deadline IS DISTINCT FROM p_working_deadline
       OR existing.backup_retention_policy_deadline IS DISTINCT FROM p_backup_deadline
       OR existing.revoke_key IS DISTINCT FROM p_revoke_key
       OR existing.revoke_sha256 IS DISTINCT FROM p_revoke_sha256
       OR existing.revoke_version IS DISTINCT FROM p_revoke_version
       OR existing.purged_key IS DISTINCT FROM p_purged_key
       OR existing.purged_sha256 IS DISTINCT FROM p_purged_sha256
       OR existing.purged_version IS DISTINCT FROM p_purged_version
       OR existing.original_source_empty_at IS DISTINCT FROM p_original_source_empty_at
       OR existing.original_local_mail_cleared_at IS DISTINCT FROM p_original_local_mail_cleared_at
       OR existing.original_metadata_purged_at IS DISTINCT FROM p_original_metadata_purged_at THEN
      RAISE EXCEPTION 'conflicting restore erasure registration';
    END IF;
    RETURN existing.metadata_present;
  END IF;

  SELECT * INTO tenant_row FROM public.tenants WHERE id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM public.accounts WHERE id=p_account_id) THEN
      RAISE EXCEPTION 'restored erasure identity is partially present';
    END IF;
    INSERT INTO public.account_restore_suppressions(
      restore_run_id,deletion_id,account_id,tenant_id,ledger_id,ledger_state,
      metadata_present,state,requested_at,revoked_at,policy_version,
      working_data_policy_deadline,backup_retention_policy_deadline,
      revoke_key,revoke_sha256,revoke_version,
      purged_key,purged_sha256,purged_version,original_source_empty_at,
      original_local_mail_cleared_at,original_metadata_purged_at
    ) VALUES(
      p_restore_run_id,p_deletion_id,p_account_id,p_tenant_id,p_ledger_id,
      p_ledger_state,false,'registered',p_requested_at,p_revoked_at,
      p_policy_version,p_working_deadline,p_backup_deadline,p_revoke_key,
      p_revoke_sha256,p_revoke_version,p_purged_key,p_purged_sha256,p_purged_version,
      p_original_source_empty_at,p_original_local_mail_cleared_at,
      p_original_metadata_purged_at
    );
    RETURN false;
  END IF;
  SELECT * INTO account_row FROM public.accounts WHERE id=p_account_id FOR UPDATE;
  IF NOT FOUND OR tenant_row.owner_id<>p_account_id THEN
    RAISE EXCEPTION 'restored erasure identity mismatch';
  END IF;
  SELECT * INTO deletion_row FROM public.account_deletions
   WHERE account_id=p_account_id FOR UPDATE;
  IF FOUND AND deletion_row.id<>p_deletion_id THEN
    RAISE EXCEPTION 'restored erasure request mismatch';
  END IF;

  UPDATE public.accounts SET disabled=true,
    deletion_requested_at=COALESCE(deletion_requested_at,p_requested_at)
   WHERE id=p_account_id;
  UPDATE public.agent_connections SET
    revoked_at=COALESCE(revoked_at,GREATEST(clock_timestamp(),created_at))
   WHERE tenant_id=p_tenant_id;
  DELETE FROM public.viewer_grants viewer USING public.revisions revision
   WHERE viewer.revision_id=revision.id AND revision.tenant_id=p_tenant_id;
  DELETE FROM public.grants issued USING public.shares share
   WHERE issued.share_id=share.id AND share.tenant_id=p_tenant_id;
  UPDATE public.editorial_publications SET
    withdrawn_at=COALESCE(withdrawn_at,clock_timestamp())
   WHERE tenant_id=p_tenant_id AND withdrawn_at IS NULL;
  UPDATE public.shares SET revoked=true WHERE tenant_id=p_tenant_id;
  UPDATE public.uploads SET aborted=true WHERE tenant_id=p_tenant_id AND receipt IS NULL;
  UPDATE public.revision_derivatives SET
    attempt_expires_at=LEAST(attempt_expires_at,clock_timestamp()),
    updated_at=clock_timestamp()
   WHERE tenant_id=p_tenant_id AND state='pending';
  DELETE FROM public.sessions WHERE account_id=p_account_id;

  SELECT count(*)::integer INTO artifact_total FROM public.artifacts WHERE tenant_id=p_tenant_id;
  SELECT count(*)::integer INTO revision_total FROM public.revisions WHERE tenant_id=p_tenant_id;
  purge_hours:=GREATEST(1,LEAST(8760,CEIL(EXTRACT(EPOCH FROM (p_working_deadline-p_requested_at))/3600)::integer));
  backup_days:=GREATEST(0,LEAST(3650,CEIL(EXTRACT(EPOCH FROM (p_backup_deadline-p_requested_at))/86400)::integer));
  IF deletion_row.id IS NULL THEN
    INSERT INTO public.account_deletions(
      id,account_id,tenant_id,state,status_capability_hash,plan_expires_at,
      artifact_count,revision_count,source_bytes,derivative_bytes,
      policy_version,purge_max_hours,backup_retention_max_days,planned_at,
      requested_at,revoked_at,working_data_policy_deadline,
      backup_retention_policy_deadline,confirmation_session_hash
    ) VALUES(
      p_deletion_id,p_account_id,p_tenant_id,'access_revoked_pending_purge',
      p_status_capability_hash,clock_timestamp(),artifact_total,revision_total,
      tenant_row.used_bytes,tenant_row.derivative_used_bytes,p_policy_version,
      purge_hours,backup_days,p_requested_at,p_requested_at,p_revoked_at,
      p_working_deadline,p_backup_deadline,p_confirmation_hash
    );
  ELSE
    UPDATE public.account_deletions SET state='access_revoked_pending_purge',
      status_capability_hash=p_status_capability_hash,plan_expires_at=clock_timestamp(),
      artifact_count=artifact_total,revision_count=revision_total,
      source_bytes=tenant_row.used_bytes,derivative_bytes=tenant_row.derivative_used_bytes,
      policy_version=p_policy_version,purge_max_hours=purge_hours,
      backup_retention_max_days=backup_days,requested_at=p_requested_at,
      revoked_at=p_revoked_at,working_data_policy_deadline=p_working_deadline,
      backup_retention_policy_deadline=p_backup_deadline,
      confirmation_session_hash=p_confirmation_hash,purged_at=NULL,
      retry_at=NULL,error_code=NULL WHERE id=p_deletion_id;
  END IF;

  INSERT INTO public.account_purge_jobs(
    deletion_id,account_id,tenant_id,ledger_id,phase,requested_at,revoked_at,
    policy_version,working_data_policy_deadline,backup_retention_policy_deadline,
    retry_at,revoke_key,revoke_sha256,revoke_version
  ) VALUES(
    p_deletion_id,p_account_id,p_tenant_id,p_ledger_id,'deleting_source',
    p_requested_at,p_revoked_at,p_policy_version,p_working_deadline,
    p_backup_deadline,clock_timestamp(),p_revoke_key,p_revoke_sha256,
    p_revoke_version
  ) ON CONFLICT(deletion_id) DO UPDATE SET
    account_id=excluded.account_id,tenant_id=excluded.tenant_id,
    ledger_id=excluded.ledger_id,phase='deleting_source',
    requested_at=excluded.requested_at,revoked_at=excluded.revoked_at,
    policy_version=excluded.policy_version,
    working_data_policy_deadline=excluded.working_data_policy_deadline,
    backup_retention_policy_deadline=excluded.backup_retention_policy_deadline,
    attempt_id=NULL,attempt_expires_at=NULL,retry_at=clock_timestamp(),
    error_code=NULL,revoke_key=excluded.revoke_key,
    revoke_sha256=excluded.revoke_sha256,revoke_version=excluded.revoke_version,
    source_empty_verified_at=NULL,local_mail_cleared_at=NULL,
    metadata_purged_at=NULL,deleted_publications=NULL,purged_key=NULL,
    purged_sha256=NULL,purged_version=NULL,terminal_delete_authorized=false,
    updated_at=clock_timestamp();
  INSERT INTO public.account_restore_suppressions(
    restore_run_id,deletion_id,account_id,tenant_id,ledger_id,ledger_state,
    metadata_present,state,requested_at,revoked_at,policy_version,
    working_data_policy_deadline,backup_retention_policy_deadline,
    revoke_key,revoke_sha256,revoke_version,
    purged_key,purged_sha256,purged_version,original_source_empty_at,
    original_local_mail_cleared_at,original_metadata_purged_at
  ) VALUES(
    p_restore_run_id,p_deletion_id,p_account_id,p_tenant_id,p_ledger_id,
    p_ledger_state,true,'registered',p_requested_at,p_revoked_at,
    p_policy_version,p_working_deadline,p_backup_deadline,p_revoke_key,
    p_revoke_sha256,p_revoke_version,p_purged_key,p_purged_sha256,p_purged_version,
    p_original_source_empty_at,p_original_local_mail_cleared_at,
    p_original_metadata_purged_at
  );
  RETURN true;
END $$;

CREATE FUNCTION acknowledge_historic_restored_purge(
  p_restore_run_id uuid,p_deletion_id uuid,p_attempt_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  suppression public.account_restore_suppressions%ROWTYPE;
  job public.account_purge_jobs%ROWTYPE;
BEGIN
  SELECT * INTO suppression FROM public.account_restore_suppressions
   WHERE restore_run_id=p_restore_run_id AND deletion_id=p_deletion_id FOR UPDATE;
  IF NOT FOUND OR NOT suppression.metadata_present THEN
    RETURN false;
  END IF;
  job:=public.lock_account_purge_job(p_deletion_id,p_attempt_id);
  IF job.phase<>'metadata_purged' OR job.metadata_purged_at IS NULL THEN
    RAISE EXCEPTION 'restored metadata is not purged';
  END IF;
  IF suppression.ledger_state='purged' THEN
    UPDATE public.account_purge_jobs SET phase='purged',
      purged_key=suppression.purged_key,purged_sha256=suppression.purged_sha256,
      purged_version=suppression.purged_version,attempt_id=NULL,
      attempt_expires_at=NULL,error_code=NULL,retry_at=clock_timestamp(),
      updated_at=clock_timestamp() WHERE deletion_id=p_deletion_id;
    UPDATE public.account_deletions SET state='purged',
      purged_at=suppression.original_metadata_purged_at,
      retry_at=NULL,error_code=NULL,confirmation_session_hash=NULL,
      artifact_count=0,revision_count=0,source_bytes=0,derivative_bytes=0
     WHERE id=p_deletion_id;
  ELSE
    UPDATE public.account_purge_jobs SET phase='restore_suppressed',
      attempt_id=NULL,attempt_expires_at=NULL,error_code=NULL,
      retry_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE deletion_id=p_deletion_id;
    UPDATE public.account_deletions SET retry_at=NULL,error_code=NULL,
      artifact_count=0,revision_count=0,source_bytes=0,derivative_bytes=0
     WHERE id=p_deletion_id;
  END IF;
  UPDATE public.account_restore_suppressions SET state='completed',
    local_source_empty_at=job.source_empty_verified_at,
    local_metadata_purged_at=job.metadata_purged_at,
    completed_at=clock_timestamp()
   WHERE restore_run_id=p_restore_run_id AND deletion_id=p_deletion_id;
  RETURN true;
END $$;

CREATE FUNCTION claim_restored_account_purge_job(
  p_restore_run_id uuid,p_deletion_id uuid,p_attempt_id uuid,p_ledger_id uuid
) RETURNS public.account_purge_snapshot
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.account_purge_jobs%ROWTYPE;
BEGIN
  SELECT purge.* INTO job FROM public.account_purge_jobs purge
    JOIN public.account_restore_suppressions suppression
      ON suppression.deletion_id=purge.deletion_id
   WHERE suppression.restore_run_id=p_restore_run_id
     AND suppression.deletion_id=p_deletion_id
     AND suppression.metadata_present AND suppression.state='registered';
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.tenants WHERE id=job.tenant_id FOR UPDATE;
  PERFORM 1 FROM public.accounts WHERE id=job.account_id FOR UPDATE;
  PERFORM 1 FROM public.account_deletions WHERE id=job.deletion_id FOR UPDATE;
  SELECT * INTO job FROM public.account_purge_jobs
   WHERE deletion_id=p_deletion_id FOR UPDATE;
  IF job.phase NOT IN ('deleting_source','source_empty','metadata_purged')
     OR (job.attempt_expires_at IS NOT NULL
         AND job.attempt_expires_at>=clock_timestamp())
     OR job.ledger_id<>p_ledger_id THEN RETURN NULL; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.accounts account
    JOIN public.account_deletions deletion ON deletion.account_id=account.id
    WHERE account.id=job.account_id AND deletion.id=job.deletion_id
      AND account.disabled AND account.deletion_requested_at IS NOT NULL
      AND deletion.state IN ('access_revoked_pending_purge','failed')
  ) THEN RAISE EXCEPTION 'restored purge owner is not revoked'; END IF;
  UPDATE public.account_purge_jobs SET attempt_id=p_attempt_id,
    attempt_expires_at=clock_timestamp()+interval '10 minutes',
    attempt_count=attempt_count+1,error_code=NULL,updated_at=clock_timestamp()
   WHERE deletion_id=p_deletion_id RETURNING * INTO job;
  RETURN ROW(
    job.deletion_id,job.account_id,job.tenant_id,job.ledger_id,job.phase,
    job.requested_at,job.revoked_at,job.policy_version,
    job.working_data_policy_deadline,job.backup_retention_policy_deadline,
    job.revoke_sha256,job.source_empty_verified_at,
    job.local_mail_cleared_at,job.metadata_purged_at
  )::public.account_purge_snapshot;
END $$;

CREATE FUNCTION restored_erasure_status(p_restore_run_id uuid,p_deletion_id uuid)
RETURNS TABLE(state text,metadata_present boolean,tenant_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT suppression.state,suppression.metadata_present,suppression.tenant_id
    FROM public.account_restore_suppressions suppression
   WHERE suppression.restore_run_id=p_restore_run_id
     AND suppression.deletion_id=p_deletion_id
$$;

CREATE FUNCTION complete_absent_restore_suppression(
  p_restore_run_id uuid,p_deletion_id uuid,p_source_empty_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  UPDATE public.account_restore_suppressions SET state='completed',
    local_source_empty_at=p_source_empty_at,local_metadata_purged_at=clock_timestamp(),
    completed_at=clock_timestamp()
   WHERE restore_run_id=p_restore_run_id AND deletion_id=p_deletion_id
     AND NOT metadata_present AND state='registered';
  IF NOT FOUND THEN RAISE EXCEPTION 'absent restore suppression is not pending'; END IF;
END $$;

REVOKE ALL ON TABLE account_restore_suppressions FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION register_restored_erasure(uuid,uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,timestamptz,text,text,text,text,text,text,timestamptz,timestamptz,timestamptz,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION acknowledge_historic_restored_purge(uuid,uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_restored_account_purge_job(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_absent_restore_suppression(uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION restored_erasure_status(uuid,uuid) FROM PUBLIC;
