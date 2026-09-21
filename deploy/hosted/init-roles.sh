#!/bin/sh
# First start of the bundled PostgreSQL only: dedicated database with a separate
# schema owner (migrations) and an unprivileged runtime login (app, maintenance).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=schema_password="$POLKA_SCHEMA_PASSWORD" \
  --set=runtime_password="$POLKA_RUNTIME_PASSWORD" <<'SQL'
CREATE ROLE polka_schema LOGIN PASSWORD :'schema_password';
CREATE ROLE polka_runtime LOGIN PASSWORD :'runtime_password';
CREATE DATABASE polka;
REVOKE ALL ON DATABASE polka FROM PUBLIC;
GRANT CONNECT ON DATABASE polka TO polka_schema, polka_runtime;
ALTER ROLE polka_runtime SET search_path = pg_catalog, public;
\connect polka
ALTER SCHEMA public OWNER TO polka_schema;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE polka_schema REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SQL
