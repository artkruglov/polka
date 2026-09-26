-- Operator-reviewed grants for the isolated account purge worker at schema 047.
-- The worker role and password are provisioned separately. Run this recipe as
-- the actual schema owner of a dedicated Polka database.
-- psql -X --set=ON_ERROR_STOP=1 --set=schema_owner=polka_schema \
--   --set=worker_role=polka_purge --file=deploy/purge-worker-grants.sql
\set ON_ERROR_STOP on
\if :{?schema_owner}
\else
  \echo schema_owner is required
  \quit 2
\endif
\if :{?worker_role}
\else
  \echo worker_role is required
  \quit 2
\endif

BEGIN;
SELECT set_config('polka_purge.schema_owner', :'schema_owner', true),
       set_config('polka_purge.worker_role', :'worker_role', true);

DO $$
DECLARE
  owner_oid oid;
  worker_record pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles
   WHERE rolname=current_setting('polka_purge.schema_owner');
  SELECT * INTO worker_record FROM pg_catalog.pg_roles
   WHERE rolname=current_setting('polka_purge.worker_role');
  IF owner_oid IS NULL OR worker_record.oid IS NULL
     OR current_user<>current_setting('polka_purge.schema_owner')
     OR owner_oid=worker_record.oid THEN
    RAISE EXCEPTION 'Run as the distinct schema owner with an existing worker';
  END IF;
  IF worker_record.rolsuper OR worker_record.rolcreatedb
     OR worker_record.rolcreaterole OR worker_record.rolreplication
     OR worker_record.rolbypassrls OR NOT worker_record.rolcanlogin
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=worker_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=worker_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=worker_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=worker_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=worker_record.oid) THEN
    RAISE EXCEPTION 'Purge worker must be an unprivileged login without membership or ownership';
  END IF;
  IF NOT has_database_privilege(worker_record.oid,current_database(),'CONNECT')
     OR has_database_privilege(worker_record.oid,current_database(),'CREATE') THEN
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
     OR (SELECT count(*) FROM public.schema_migrations)<>47
     OR (SELECT min(version) FROM public.schema_migrations)<>1
     OR (SELECT max(version) FROM public.schema_migrations)<>47 THEN
    RAISE EXCEPTION 'Purge grants require exactly migrations 001 through 047';
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC, :"worker_role";
GRANT USAGE ON SCHEMA public TO :"worker_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, :"worker_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, :"worker_role";
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, :"worker_role";

GRANT EXECUTE ON FUNCTION public.claim_account_purge_job(uuid,uuid) TO :"worker_role";
GRANT EXECUTE ON FUNCTION public.acknowledge_account_purge_revoke(uuid,uuid,text,text,text) TO :"worker_role";
GRANT EXECUTE ON FUNCTION public.mark_account_purge_source_empty(uuid,uuid,timestamptz) TO :"worker_role";
GRANT EXECUTE ON FUNCTION public.yield_account_purge_attempt(uuid,uuid) TO :"worker_role";
GRANT EXECUTE ON FUNCTION public.lock_account_purge_mail(uuid,uuid) TO :"worker_role";
GRANT EXECUTE ON FUNCTION public.complete_account_purge_mail(uuid,uuid,timestamptz,uuid[]) TO :"worker_role";
GRANT EXECUTE ON FUNCTION public.terminal_erase_account_metadata(uuid,uuid,text) TO :"worker_role";
GRANT EXECUTE ON FUNCTION public.acknowledge_account_purge_terminal(uuid,uuid,text,text,text) TO :"worker_role";
GRANT EXECUTE ON FUNCTION public.fail_account_purge_attempt(uuid,uuid,text) TO :"worker_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner"
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, :"worker_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, :"worker_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner"
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, :"worker_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, :"worker_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner"
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, :"worker_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, :"worker_role";
COMMIT;
\echo Purge worker grants installed for reviewed schema through migration 047
