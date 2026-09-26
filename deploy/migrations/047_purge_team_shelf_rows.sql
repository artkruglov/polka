-- Account erasure and department shelves (docs/specs/TEAM_SHELVES.md, «После
-- ревью этапов 2–4»). terminal_erase_account_metadata (030) erases an
-- account's agent rows on its own shelf only. Since 045 an account may also
-- have agents on department shelves; those shelves and their works stay with
-- the company, so the rows that describe the account there go now:
--
-- oauth_refresh_tokens, oauth_authorizations, url_import_jobs,
-- agent_sign_in_links   deleted.
-- agent_connections     kept (uploads, agent operations and the audit
--                       outbox of the shelf's works refer to them) but
--                       emptied: a neutral name, a token hash nobody holds,
--                       no last-seen time; revoked.
--
-- It runs when the erasure renames the account to deleted-<id> (030), the one
-- step no other path takes, inside the same SECURITY DEFINER transaction.
CREATE FUNCTION erase_account_department_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  DELETE FROM public.oauth_refresh_tokens token
   USING public.tenants tenant
   WHERE token.account_id=NEW.id AND tenant.id=token.tenant_id AND tenant.kind='team';
  DELETE FROM public.oauth_authorizations authorization_row
   USING public.tenants tenant
   WHERE authorization_row.account_id=NEW.id AND tenant.id=authorization_row.tenant_id
     AND tenant.kind='team';
  DELETE FROM public.url_import_jobs job
   USING public.tenants tenant
   WHERE job.account_id=NEW.id AND tenant.id=job.tenant_id AND tenant.kind='team';
  DELETE FROM public.agent_sign_in_links link
   USING public.agent_connections connection
   WHERE link.connection_id=connection.id AND connection.account_id=NEW.id;
  UPDATE public.agent_connections connection
     SET name='Удалённое подключение',
         token_hash=encode(pg_catalog.sha256(pg_catalog.convert_to('erased:'||connection.id::text,'UTF8')),'hex'),
         last_seen_at=NULL,
         revoked_at=COALESCE(connection.revoked_at,clock_timestamp())
    FROM public.tenants tenant
   WHERE connection.account_id=NEW.id AND tenant.id=connection.tenant_id
     AND tenant.kind='team';
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION erase_account_department_rows() FROM PUBLIC;

CREATE TRIGGER erase_account_department_rows
  AFTER UPDATE OF name ON accounts
  FOR EACH ROW
  WHEN (NEW.name = 'deleted-' || NEW.id::text AND OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION erase_account_department_rows();
