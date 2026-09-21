-- Include URL requests and prepared source bytes in terminal account erasure.
-- Tenants survive anonymization, so their ON DELETE CASCADE does not run.
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
