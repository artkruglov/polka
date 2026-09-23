# Self-host base candidate

This is a draft for experienced operators; the recommended path is the single-VM setup in [hosted/README.md](hosted/README.md). It is a compose draft for an operator-provided database, versioned private S3-compatible bucket, and one already-built Polka release image. It is a deployment candidate, not production acceptance or a hosted interactive beta.

Copy `deploy/base.env.example` to an untracked `deploy/base.env`, fill the runtime credentials, schema-owner URL, bucket settings, public `APP_ORIGIN`, and one exact `POLKA_IMAGE` digest. Before rendering compose, run `node --env-file=deploy/base.env deploy/check-base-image.mjs`; this is an offline format check and does not pull or build an image. The schema-owner URL is passed only to the migration job; `app`, `storage-check`, and `maintenance` receive the runtime `DATABASE_URL`. The migration job does not receive runtime S3, link, or app credentials. No secret has a committed default.

The sequence is `migrate` → `storage-check` → healthy `app` → `maintenance`. The storage check uses the existing `--confirm-bootstrap` capability check against the preprovisioned bucket and cleans only its own probe versions. It does not create a bucket or publish DB/S3 ports. The app binds its container listener to `0.0.0.0`, while the sample host port is limited to `127.0.0.1`; put an explicitly configured reverse proxy in front when needed. Mail is deliberately disabled in this base sample; SMTP configuration is a separate operator overlay.

No published image exists; build it from source and push it to a registry you control, which gives the image its digest:

```sh
docker build -t <registry>/polka:<tag> .
docker push <registry>/polka:<tag>
docker inspect --format '{{index .RepoDigests 0}}' <registry>/polka:<tag>   # use this value as POLKA_IMAGE
```

Use an operator-controlled immutable image and inspect the rendered file without starting services:

```sh
docker compose --env-file deploy/base.env -f deploy/compose.base.yml config -q
```

The command is read-only with respect to services, but rendered output must still be treated as sensitive because Compose resolves environment values. Do not paste it into tickets or logs. This package does not build images, provision DB/S3, create secrets, configure cloud/Kubernetes, or run browser acceptance.

For an operator-managed SMTP endpoint, provide `SMTP_HOST` and a valid `MAIL_FROM` in an untracked env file and render both files:

```sh
docker compose --env-file deploy/base.env --env-file deploy/smtp.env \
  -f deploy/compose.base.yml -f deploy/compose.smtp.yml config -q
```

The overlay changes only the `app` service to `MAIL_MODE=smtp`; migration, storage-check, and maintenance remain mail-disabled. The existing mail adapter uses `requireTLS: true` (and `secure` for port 465), so this overlay does not claim delivery or provider compatibility. Do not put SMTP secrets in the repository or paste rendered environment values into logs.

### Runtime settings passed by compose

`storage-check`, `app` and `maintenance` share one environment block (`x-runtime-env`). Besides the credentials above it passes:

- `TRUST_PROXY` (default empty): comma-separated addresses/CIDRs of the reverse proxy as the app container sees it. Only then is `X-Forwarded-For` used for client IPs (rate limits); empty means the socket address. Set it to your proxy's address, never to a range that clients can reach directly.
- `HTML_LIVE_MODE` (default `disabled`): static HTML only. The interactive viewer (`production`) requires both listeners on loopback (`HOST`/`VIEWER_HOST` `127.0.0.1`) behind a reverse proxy on the same host network, which this bridge-network shape cannot provide: the app refuses to start with a non-loopback `HOST`. Use the host-network layout of [deploy/hosted](hosted/README.md) for the viewer.
- `VIEWER_ORIGIN` (default `http://localhost:4391`, unused while disabled): the public HTTPS origin of the viewer. It is not derived from `APP_ORIGIN`; it must be a separate registrable domain (e.g. app `https://polka.example.com`, viewer `https://polka-viewer.example.net`). In deploy/hosted it is derived as `https://$VIEWER_HOST_NAME`. `VIEWER_HOST`/`VIEWER_PORT` are fixed to `127.0.0.1:4391`.
- `URL_IMPORT_ENABLED` (default `false`): import by link.
- `MIGRATION_STATEMENT_TIMEOUT_MS` (migration job only, default 120000): per-statement bound; a failed migration reports its file name and SQLSTATE and rolls back.

`ACCOUNT_DELETION_ENABLED` and `MAIL_MODE` stay fixed off in this base; mail is enabled only by the SMTP overlay.

Before startup, the schema owner must grant the runtime role access to the application tables/sequences (including SELECT on schema_migrations), and review privileges whenever a migration adds objects; future table DML is not granted automatically. Two connection URLs alone do not establish these grants. Verify upload/read/maintenance using the runtime role; do not substitute schema-owner credentials to make readiness pass.

### Separate database roles: operator recipe

`deploy/runtime-grants.sql` is a psql recipe for **exactly the reviewed migration set** (the exact set is in `packages/migrations.ts`, currently 001–033; every recipe checks it). It creates no roles, passwords or schema, and does not run automatically in Compose. Provision a dedicated Polka database, a `public` schema owned by the actual migration role, and a distinct runtime LOGIN with no elevated role attributes, membership, database/schema/object ownership or database CREATE permission. Both roles need CONNECT. This recipe deliberately rejects the default `public` owner `pg_database_owner`: the DBA must first explicitly assign this dedicated schema to the migration role. Do not use this recipe on a shared schema or an extension-owned namespace. Migration connections must create objects in `public` as the named schema owner; configure runtime search_path to trusted schemas only (`pg_catalog, public`), never a schema writable by another application or user.

Run migrations as schema owner, then review and run the grants recipe using a protected PG service/password file (not a credential URI pasted into the command). Only after successful grants start storage-check/app/maintenance. Example role names below are non-secret placeholders:

```sh
psql -X --set=ON_ERROR_STOP=1 --set=schema_owner=polka_schema \
  --set=runtime_role=polka_runtime --file=deploy/runtime-grants.sql
```

The recipe grants explicit current table DML and audit sequence usage, with SELECT-only access to schema_migrations. It removes runtime/PUBLIC schema CREATE and custom function EXECUTE, and gives no TRUNCATE, DDL or grant option. It does **not** automatically grant DML on future tables: extend this reviewed list with each migration before deployment. The current migration head is the reviewed catalog boundary; R17 application tables remain explicit, while protected purge and restore functions are granted only to their separate worker recipes below. Older or newer schema catalogs fail before grants change. Global default EXECUTE must be revoked for the dedicated schema owner because a per-schema revoke cannot remove PostgreSQL's global PUBLIC default. [PostgreSQL default privileges](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html).

Operator verification before startup: as runtime, SELECT schema_migrations succeeds but INSERT does not; app table DML and audit nextval succeed inside a rolled-back synthetic transaction; schema/table creation, TRUNCATE, role switching to schema owner and direct custom-function execution are denied. Verify direct DELETE on account_deletions/account_deletion_csrf is denied, while a synthetic plan replacement/confirm/status and session-CSRF cascade work; marker removal/re-enable and direct protected-function calls remain denied. Sequence increments from nextval are not rolled back. Verify the new active-tenant/revoke services and a bounded synthetic maintenance pass with runtime credentials. These are checks to perform against explicitly isolated resources, not evidence already obtained. The role is shared by app and maintenance; tenant isolation remains enforced by application predicates/locks, not PostgreSQL RLS. No build, role setup, grants or database commands were executed while preparing this recipe.

Grants compatibility does not enable account deletion in the base deployment: it remains default-off and HTTP-loopback-only, with purgeAvailable=false. The runtime role receives no protected purge or restore function permissions. Provision distinct unprivileged LOGINs for the purge worker and restore worker; both recipes require the same dedicated schema owner, exact reviewed catalog, and separate role ownership checks.

### Purge and restore worker recipes

Run `deploy/purge-worker-grants.sql` as the schema owner with a distinct unprivileged `worker_role`. It grants only the exact account-purge function signatures of the reviewed catalog; it does not grant table DML, ownership, broad function execution, or runtime privileges. Run `deploy/restore-worker-grants.sql` separately with distinct `restore_role`, `runtime_role`, and `worker_role` values. The restore role receives only the reviewed restore registration/status and restore-purge functions; it is not the ordinary purge worker and cannot be substituted for the application role. These recipes do not create roles or passwords and do not run from Compose.

Isolated SQL/ACL acceptance runs in `npm run verify` (`scripts/test-runtime-grants-isolated.ts --confirm-synthetic --expected-schema=<head of packages/migrations.ts>`); the earlier schema 018 run of it with mail-race checks passed 13/13 with temporary owner/runtime/purge/restore roles and no working resources. The full synthetic restore drill also passed its recorded checks, including exact remapped references, old recipient/session denial, source/metadata erasure, and preserved historic receipt. These are isolated synthetic/local checks: they do not prove production IAM, hosted deletion, container startup, or a production backup-retention policy.
