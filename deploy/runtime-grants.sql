-- Operator-reviewed recipe for the Polka schema through migration 036.
-- Run as the actual schema_owner in a dedicated Polka database AFTER migrate,
-- BEFORE app/storage-check/maintenance. No roles/passwords are created here.
-- psql -X --set=ON_ERROR_STOP=1 --set=schema_owner=polka_schema \
--   --set=runtime_role=polka_runtime --file=deploy/runtime-grants.sql
-- Supply connection credentials through the operator's protected PG service.
\set ON_ERROR_STOP on
\if :{?schema_owner}
\else
  \echo schema_owner is required
  \quit 2
\endif
\if :{?runtime_role}
\else
  \echo runtime_role is required
  \quit 2
\endif

BEGIN;
SELECT set_config('polka_grants.schema_owner', :'schema_owner', true) AS configured_owner,
       set_config('polka_grants.runtime_role', :'runtime_role', true) AS configured_runtime
\gset

DO $$
DECLARE
  owner_oid oid;
  runtime_record pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles
    WHERE rolname=current_setting('polka_grants.schema_owner');
  SELECT * INTO runtime_record FROM pg_catalog.pg_roles
    WHERE rolname=current_setting('polka_grants.runtime_role');
  IF owner_oid IS NULL OR runtime_record.oid IS NULL
     OR current_user<>current_setting('polka_grants.schema_owner')
     OR owner_oid=runtime_record.oid THEN
    RAISE EXCEPTION 'Run as the existing distinct schema owner and runtime roles';
  END IF;
  IF runtime_record.rolsuper OR runtime_record.rolcreatedb
     OR runtime_record.rolcreaterole OR runtime_record.rolreplication
     OR runtime_record.rolbypassrls OR NOT runtime_record.rolcanlogin
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=runtime_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=runtime_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=runtime_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=runtime_record.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=runtime_record.oid) THEN
    RAISE EXCEPTION 'Runtime must be an unprivileged login without membership or object ownership';
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
  IF NOT has_database_privilege(runtime_record.oid,current_database(),'CONNECT')
     OR has_database_privilege(runtime_record.oid,current_database(),'CREATE') THEN
    RAISE EXCEPTION 'Provision database CONNECT and remove database CREATE for runtime first';
  END IF;
  IF current_schema()<>'public'
     OR (SELECT count(*) FROM public.schema_migrations)<>36
     OR (SELECT min(version) FROM public.schema_migrations)<>1
     OR (SELECT max(version) FROM public.schema_migrations)<>36 THEN
    RAISE EXCEPTION 'This recipe requires public schema and exactly reviewed migrations 001 through 036';
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC, :"runtime_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role";

-- Explicit permissions also remove stale direct privileges from earlier setup.
-- This is a DEDICATED Polka schema: do not run against a shared application DB.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, :"runtime_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, :"runtime_role";
GRANT SELECT ON TABLE public.schema_migrations TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.accounts, public.tenants, public.sessions, public.login_limits,
  public.folders, public.artifacts, public.revisions, public.uploads,
  public.shares, public.grants, public.audit_outbox, public.share_reports,
  public.login_challenges, public.viewer_grants, public.upload_files,
  public.revision_files, public.revision_derivatives,
  public.agent_connections, public.agent_connection_csrf,
  public.agent_operations, public.editorial_publications, public.url_import_jobs
TO :"runtime_role";
-- R17 first slice reads/inserts/updates plans and CSRF only. No terminal purge
-- DELETE or extra sequence/function rights are required. CSRF rows are removed
-- by the existing sessions FK cascade when sessions are deleted.
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.account_deletions, public.account_deletion_csrf
TO :"runtime_role";
GRANT USAGE, SELECT ON SEQUENCE public.audit_outbox_id_seq TO :"runtime_role";
GRANT USAGE, SELECT ON SEQUENCE public.template_library_events_id_seq TO :"runtime_role";

-- Application code currently calls no custom SQL routine directly. Trigger
-- execution does not require granting the runtime direct routine execution.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, :"runtime_role";
-- Must be GLOBAL for this owner: IN SCHEMA cannot revoke PostgreSQL's global
-- default PUBLIC EXECUTE. This owner must be dedicated to this Polka database.
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner"
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, :"runtime_role";

-- No automatic DML/sequence grant on future objects. Extend the explicit list
-- only with each reviewed migration; protected R17 functions require their own
-- exact-signature grant to an explicitly selected role, never ALL FUNCTIONS.
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner"
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner"
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, :"runtime_role";
GRANT SELECT, INSERT ON public.template_releases TO :"runtime_role";
-- Capabilities are immutable and disappear through their parent cascades.
GRANT SELECT, INSERT ON public.template_library_viewer_grants TO :"runtime_role";
-- Library foundation uses row locks and soft revocation. No runtime DELETE.
GRANT SELECT, INSERT, UPDATE ON
  public.template_libraries, public.template_library_members,
  public.template_library_publications, public.template_library_invitations TO :"runtime_role";
-- The application appends and reads the library journal. Redaction is performed
-- only by the protected terminal-tombstone trigger.
GRANT SELECT, INSERT ON public.template_library_events TO :"runtime_role";
-- Remote MCP connector (028). The application registers clients, records
-- authorization requests and rotates refresh tokens; maintenance removes
-- expired rows. Terminal purge erases per-account rows in its own function.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.oauth_clients, public.oauth_authorizations, public.oauth_refresh_tokens
TO :"runtime_role";
-- Abuse protection (029) adds only columns to accounts, shares, revisions and
-- share_reports, which the runtime already reads and writes above.
-- Comments (030): the application soft-deletes comments (no runtime DELETE)
-- and toggles reactions (DELETE). Terminal purge erases both in its function.
GRANT SELECT, INSERT, UPDATE ON TABLE public.comments TO :"runtime_role";
GRANT SELECT, INSERT, DELETE ON TABLE public.comment_reactions TO :"runtime_role";
-- Content filter (031): the journal is append-only for the runtime. UPDATE is
-- not granted; DELETE is granted for the 3-year retention in maintenance and
-- the table's trigger refuses it for any younger event. Blocks are updated
-- (legal hold, purge, release) and removed after the retention.
GRANT SELECT, INSERT, DELETE ON TABLE public.moderation_events TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.moderation_blocks TO :"runtime_role";
-- Requests from /enterprise (033): the application records a request and marks
-- the operator letter sent; maintenance deletes requests older than a year.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.enterprise_requests TO :"runtime_role";
-- Sign-in providers (032): the application links identities, stamps their
-- last use and unlinks them from settings. Erasure is a protected trigger.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.account_identities TO :"runtime_role";
-- Product analytics (034): the application appends events and counters and
-- reads them for the operator report; maintenance deletes raw events and
-- active days after 13 months and those of deleted accounts; an objection
-- deletes an account's rows and records its opt-out. Counters are never
-- deleted by the runtime.
GRANT SELECT, INSERT, DELETE ON TABLE
  public.analytics_events, public.analytics_active_days
TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON TABLE public.analytics_daily TO :"runtime_role";
GRANT SELECT, INSERT ON TABLE public.analytics_optouts TO :"runtime_role";
-- Shelf access (036): provisional shelves add only columns to accounts and
-- agent_connections. Sign-in links from agents: the application issues and
-- consumes them; maintenance deletes expired rows; purge removes them with
-- their connection (ON DELETE CASCADE).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_sign_in_links TO :"runtime_role";
COMMIT;
\echo Runtime grants installed for the reviewed schema through migration 036
