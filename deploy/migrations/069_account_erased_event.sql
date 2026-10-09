-- An erased account leaves one row in the installation journal (context.auditFeed,
-- docs/specs/EXTENSIONS.md): account.erased, so an extension that keeps derived
-- data (the control centre's index of sessions) learns of it without comparing
-- against accounts. No personal data: the account's id is the target, the
-- payload is empty.
--
-- It is written by the rename that ends the terminal erasure (030), which
-- happens after the purge deletes the shelf's journal (audit_outbox), so this
-- row stays. The accounts and tenants rows stay too, so the references hold.
CREATE FUNCTION erase_account_journal_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  own_shelf uuid;
BEGIN
  SELECT tenant.id INTO own_shelf FROM public.tenants tenant
   WHERE tenant.owner_id=NEW.id AND tenant.kind<>'team'
   ORDER BY tenant.created_at LIMIT 1;
  IF own_shelf IS NOT NULL THEN
    INSERT INTO public.audit_outbox(tenant_id,actor_id,actor_type,action,target_id,payload)
    VALUES (own_shelf,NEW.id,'human','account.erased',NEW.id,'{}'::jsonb);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION erase_account_journal_event() FROM PUBLIC;

CREATE TRIGGER erase_account_journal_event
  AFTER UPDATE OF name ON accounts
  FOR EACH ROW
  WHEN (NEW.name = 'deleted-' || NEW.id::text AND OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION erase_account_journal_event();
