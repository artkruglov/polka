-- Operator-reviewed grants for the restore-only erasure reconciler at schema 046.
-- This identity is distinct from both the application and ordinary purge worker.
-- Run as the actual schema owner of a dedicated Polka database.
\set ON_ERROR_STOP on
\if :{?schema_owner}
\else
  \echo schema_owner is required
  \quit 2
\endif
\if :{?restore_role}
\else
  \echo restore_role is required
  \quit 2
\endif
\if :{?runtime_role}
\else
  \echo runtime_role is required
  \quit 2
\endif
\if :{?worker_role}
\else
  \echo worker_role is required
  \quit 2
\endif

BEGIN;
SELECT set_config('polka_restore.schema_owner', :'schema_owner', true),
       set_config('polka_restore.restore_role', :'restore_role', true),
       set_config('polka_restore.runtime_role', :'runtime_role', true),
       set_config('polka_restore.worker_role', :'worker_role', true);

DO $$
DECLARE
  owner_oid oid;
  runtime_oid oid;
  worker_oid oid;
  restore_record pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles
   WHERE rolname=current_setting('polka_restore.schema_owner');
  SELECT * INTO restore_record FROM pg_catalog.pg_roles
   WHERE rolname=current_setting('polka_restore.restore_role');
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
   WHERE rolname=current_setting('polka_restore.runtime_role');
  SELECT oid INTO worker_oid FROM pg_catalog.pg_roles
   WHERE rolname=current_setting('polka_restore.worker_role');
  IF owner_oid IS NULL OR restore_record.oid IS NULL OR runtime_oid IS NULL
     OR worker_oid IS NULL
     OR current_user<>current_setting('polka_restore.schema_owner')
     OR session_user<>current_setting('polka_restore.schema_owner')
     OR restore_record.oid IN (owner_oid,runtime_oid,worker_oid)
     OR runtime_oid=worker_oid THEN
    RAISE EXCEPTION 'Run as schema owner with distinct app, purge, and restore identities';
  END IF;
  IF restore_record.rolsuper OR restore_record.rolcreatedb
     OR restore_record.rolcreaterole OR restore_record.rolreplication
     OR restore_record.rolbypassrls OR NOT restore_record.rolcanlogin
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=restore_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=restore_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=restore_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=restore_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=restore_record.oid) THEN
    RAISE EXCEPTION 'Restore worker must be an unprivileged login without membership or ownership';
  END IF;
  IF NOT has_database_privilege(restore_record.oid,current_database(),'CONNECT')
     OR has_database_privilege(restore_record.oid,current_database(),'CREATE') THEN
    RAISE EXCEPTION 'Provision database CONNECT and remove database CREATE first';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace
                WHERE nspname='public' AND nspowner=owner_oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relowner<>owner_oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
                JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND p.proowner<>owner_oid) THEN
    RAISE EXCEPTION 'Require a dedicated public schema and objects owned by schema_owner';
  END IF;
  IF current_schema()<>'public'
     OR (SELECT count(*) FROM public.schema_migrations)<>46
     OR (SELECT min(version) FROM public.schema_migrations)<>1
     OR (SELECT max(version) FROM public.schema_migrations)<>46 THEN
    RAISE EXCEPTION 'Restore grants require exactly migrations 001 through 046';
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC, :"restore_role";
GRANT USAGE ON SCHEMA public TO :"restore_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, :"restore_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, :"restore_role";
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, :"restore_role";
GRANT SELECT ON TABLE public.schema_migrations TO :"restore_role";

GRANT EXECUTE ON FUNCTION public.register_restored_erasure(uuid,uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,timestamptz,text,text,text,text,text,text,timestamptz,timestamptz,timestamptz,text,text) TO :"restore_role";
GRANT EXECUTE ON FUNCTION public.claim_restored_account_purge_job(uuid,uuid,uuid,uuid) TO :"restore_role";
GRANT EXECUTE ON FUNCTION public.mark_account_purge_source_empty(uuid,uuid,timestamptz) TO :"restore_role";
GRANT EXECUTE ON FUNCTION public.yield_account_purge_attempt(uuid,uuid) TO :"restore_role";
GRANT EXECUTE ON FUNCTION public.lock_account_purge_mail(uuid,uuid) TO :"restore_role";
GRANT EXECUTE ON FUNCTION public.complete_account_purge_mail(uuid,uuid,timestamptz,uuid[]) TO :"restore_role";
GRANT EXECUTE ON FUNCTION public.terminal_erase_account_metadata(uuid,uuid,text) TO :"restore_role";
GRANT EXECUTE ON FUNCTION public.acknowledge_historic_restored_purge(uuid,uuid,uuid) TO :"restore_role";
GRANT EXECUTE ON FUNCTION public.fail_account_purge_attempt(uuid,uuid,text) TO :"restore_role";
GRANT EXECUTE ON FUNCTION public.complete_absent_restore_suppression(uuid,uuid,timestamptz) TO :"restore_role";
GRANT EXECUTE ON FUNCTION public.restored_erasure_status(uuid,uuid) TO :"restore_role";

ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner"
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, :"restore_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, :"restore_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner"
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, :"restore_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, :"restore_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner"
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, :"restore_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, :"restore_role";
COMMIT;
\echo Restore worker grants installed for reviewed schema through migration 046
