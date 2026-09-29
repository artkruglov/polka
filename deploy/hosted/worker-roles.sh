#!/bin/sh
# The purge and restore roles on an installation that already runs
# (init-roles.sh makes them only at the first start of PostgreSQL, so enabling
# account-erase or restore later leaves them missing and `grants` skips them
# without a word). Idempotent: creates each role whose password is set, sets
# that password, and gives it CONNECT on the database. Run inside the
# postgres container, with the passwords in its environment:
#
#   docker compose --env-file hosted.env exec -T postgres sh -s < worker-roles.sh
#
# then `docker compose --env-file hosted.env run --rm grants` gives them their
# functions (purge-worker-grants.sql, restore-worker-grants.sql).
set -eu
for spec in polka_purge:POLKA_PURGE_PASSWORD polka_restore:POLKA_RESTORE_PASSWORD; do
  role=${spec%%:*}
  eval "password=\${${spec##*:}:-}"
  if [ -z "$password" ]; then
    echo "$role: ${spec##*:} is not set, skipped"
    continue
  fi
  psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-polka_admin}" --dbname postgres \
    --set=role="$role" --set=password="$password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'role', :'password') \gexec
SELECT format('GRANT CONNECT ON DATABASE polka TO %I', :'role') \gexec
SELECT format('ALTER ROLE %I SET search_path = pg_catalog, public', :'role') \gexec
SQL
  echo "$role: ready"
done
