# Self-host container review

This container packages the current Polka application and its Vite-built frontend. The server registers `/app/dist` at startup, so the image starts the same Node entrypoint used by the local application.

Build locally:

```sh
docker build -t polka-self-host:local .
```

Run it with configuration supplied by the operator:

```sh
docker run --rm --user 1000:1000 -p 4390:4390 \
  --env-file .env \
  -e HOST=0.0.0.0 -e PORT=4390 \
  polka-self-host:local
```

The image does not contain `.env`, local state, tests, documentation, or the Git checkout. It runs as the unprivileged `node` user and contains the application runtime dependencies plus the source modules required by the TypeScript Node entrypoint.

The image also includes the migration and maintenance entrypoints and SQL migrations. With the same operator-supplied environment, run `node --import tsx scripts/migrate.ts`, `node --import tsx scripts/account.ts`, or `node --import tsx scripts/maintenance.ts` as one-off container commands before or alongside the server. The local npm shortcuts expect a physical `.env` file; `docker --env-file` injects environment variables but does not mount that file. The image does not include the local compose file or infrastructure services.

This Dockerfile is a candidate for a reproducible self-host image; a completed
image build and runtime smoke are not yet proven. Database, S3-compatible
storage, mail, TLS, migrations, backups, restore procedures, health
orchestration, and secret management remain operator responsibilities. The
image has no bundled persistence and does not provide a restore path. Keep
`HTML_LIVE_ENABLED=false` unless the separate loopback-only viewer
configuration is intentionally supplied.

## Verification state

The candidate keeps the Node 22 Bookworm base pinned to
`sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`.
Docker Desktop lists that digest locally as `linux/amd64`, but its local content
store is incomplete: attempting to add a local alias fails because config
content `sha256:97aaa653fb55806b0d7acc6c93dd4f3f06b373a286c988bd68c0527d4310bb05`
is missing.

On 2026-09-20, a normal BuildKit build stopped at:

```text
#2 [internal] load metadata for docker.io/library/node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
```

It produced no further output for 60 seconds and was canceled. An explicit
`--platform=linux/amd64 --pull=false` diagnostic stopped at the same metadata
step. The legacy builder also made no progress before cancellation. No build or
runtime process was left running. These bounded attempts did not alter proxy,
registry, or Docker Desktop security settings.

The source-side packaging checks passed: `scripts/migrate.ts` and migrations
001 through 012 exist, and the runtime stage explicitly copies both `scripts`
and `deploy/migrations`. The non-mutating check intentionally did not execute
the migration entrypoint because it has no help-only mode and would connect to
the configured database. Once an image is available, its presence can be
checked without database mutation:

```sh
docker run --rm --entrypoint /bin/sh polka-self-host:local -c \
  'test -f /app/scripts/migrate.ts && test -f /app/deploy/migrations/012_agent_share_operations.sql'
```

The intended operator command remains `node --import tsx scripts/migrate.ts`;
it uses environment variables supplied to the container and does not depend on
the repository's npm `.env` shortcuts. `.dockerignore` excludes `.env`,
`.env.*`, local state, tests, documentation, Git metadata, `node_modules`, and
existing build output, while deliberately retaining `.env.example`.

Because the base metadata/content issue prevented creation of
`polka-self-host:local`, no container runtime smoke or self-host acceptance is
claimed. A future retry should first restore registry access or the missing
local base content; repeated builds against the current Docker state provide no
additional evidence.

## 21.09.2026: local base revalidation

Root inspected the exact pinned image and tried only `docker run --rm --pull=never --network none --read-only --entrypoint node <pinned-image> --version`. Exit125: the same config digest97aaa653… is missing from Docker content storage. No network pull/build/proxy change attempted, no container started. Registry/content repair remains necessary before image acceptance. The new operational restore CLI now exists and passed isolated local acceptance; this does not change the image-build limitation above.
