-- Erasing an account: the service accounts it answered for (058), the card of
-- its own shelf (056) and its mark as a work's owner (057).
--
-- erase_account_department_rows (047) already revokes the account's agent
-- connections on department shelves, service ones included. What it left is a
-- service account still marked active with an erased person responsible. It is
-- now frozen the same way a departure freezes it: an admin names a new
-- responsible person and a fresh token is issued.
CREATE OR REPLACE FUNCTION erase_account_department_rows() RETURNS trigger
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
  UPDATE public.service_principals
     SET status='frozen', frozen_at=clock_timestamp()
   WHERE responsible_account_id=NEW.id AND status='active';
  -- 056, 057: the shelf card of this person's own shelf (the tenants row stays
  -- after erasure) and their name as the owner of works on department shelves.
  UPDATE public.tenants SET card_md=NULL WHERE owner_id=NEW.id AND card_md IS NOT NULL;
  UPDATE public.artifacts SET owner_account_id=NULL WHERE owner_account_id=NEW.id;
  RETURN NEW;
END $$;
