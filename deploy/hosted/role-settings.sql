-- Session limits each login role of the bundled PostgreSQL gets by default,
-- and pg_stat_statements for the operator. Idempotent; runs at the first start
-- of PostgreSQL (mounted into docker-entrypoint-initdb.d after init-roles.sh)
-- and, on an installation that already runs, once by hand as the admin:
--
--   docker compose --env-file hosted.env exec -T postgres \
--     psql -X -v ON_ERROR_STOP=1 -U polka_admin -d postgres < role-settings.sql
--
-- A role default applies to every new connection that does not set its own:
-- the app (apps/server/db.ts) and maintenance set statement_timeout per
-- connection anyway; these bound what does not, such as an operator's psql,
-- a one-off script or a worker stuck between the statements of a transaction.
-- pg_dump and pg_restore (backup, restore) turn both limits off for their own
-- session, and migrate sets its own statement_timeout, so the schema owner
-- gets only the idle-in-transaction bound.
\set ON_ERROR_STOP 1
SELECT format('ALTER ROLE %I SET %s = %L', rolname, setting, value)
FROM pg_roles
JOIN (VALUES
  ('polka_runtime', 'statement_timeout', '15s'),
  ('polka_runtime', 'idle_in_transaction_session_timeout', '60s'),
  ('polka_purge', 'statement_timeout', '60s'),
  ('polka_purge', 'idle_in_transaction_session_timeout', '5min'),
  ('polka_restore', 'statement_timeout', '60s'),
  ('polka_restore', 'idle_in_transaction_session_timeout', '5min'),
  ('polka_schema', 'idle_in_transaction_session_timeout', '15min')
) AS limits(role, setting, value) ON rolname = role
ORDER BY rolname, setting \gexec

-- Query statistics (compose.yml preloads the library). In the maintenance
-- database `postgres`, not in `polka`: the view shows every database's
-- statements from there, and the app's dumps stay free of an extension that
-- only a superuser may create, so they restore under the schema owner.
\connect postgres
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
