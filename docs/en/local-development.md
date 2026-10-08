# Local development

You need Node.js ≥ 22.16 (`.nvmrc` pins 22), npm and a running Docker. Run every command from the repository root. Russian version: [docs/local-development.md](../local-development.md).

## First run

```bash
npm ci
npm run local:setup              # writes .env with unique secrets; never touches an existing .env
npm run infra:up                 # PostgreSQL 16 (127.0.0.1:54388) and MinIO (127.0.0.1:9038)
npm run db:migrate
npm run storage:bootstrap-local  # creates a versioned bucket and checks what it supports
npm run account:create -- demo --generate
npm run build
npm run dev
```

`local:setup` prints the same sequence when it finishes. Open http://127.0.0.1:4390/ and sign in with the login and password from `.local/demo-account.txt`. Do not publish that file. You only create the account once.

The server serves the built `dist`. After a UI change run `npm run build` and reload the page; after a backend change restart `npm run dev`.

To stop the containers and keep the data: `npm run infra:stop`. Do not delete the volumes, `.env` or `LINK_KEY`: without that key old links stop opening.

`.env.example` documents every variable `local:setup` writes and the optional ones (mail, the viewer, import by URL, the renderer). Prefer `local:setup` to copying it: it generates the secrets.

### Ports and a second clone

By default PostgreSQL listens on 127.0.0.1:54388, MinIO on 127.0.0.1:9038, the application on 4390 and the interactive viewer on 4391, and the compose project is called `polka-local`. All of this is written to `.env`, and `deploy/compose.local.yml` takes the project name and ports from there. Other values are set once, when `.env` is created:

```bash
POLKA_LOCAL_PROJECT=polka-two POLKA_LOCAL_PG_PORT=55432 POLKA_LOCAL_S3_PORT=9138 \
PORT=4490 VIEWER_PORT=4491 npm run local:setup
```

That way a second clone of the repository gets its own containers and volumes and does not interfere with the first. An `.env` created by an older version has no `POLKA_LOCAL_*` or `HTML_LIVE_MODE` lines: the old ports and the static view apply, and you can add the lines by hand. The `grants` step of `npm run verify` and the account deletion tests need MinIO on 9038, so do full runs on the default ports.

### Stale volumes

If you recreated `.env` but the volumes are left from an earlier install, the password will not match and `db:migrate` fails with an authentication error. To reset the local environment, delete it together with its data and bring it up again, then repeat the first run from `db:migrate`:

```bash
docker compose --env-file=.env -f deploy/compose.local.yml down -v   # deletes the local databases and bucket
npm run infra:up
```

## Checks

```bash
npm run check          # frontend dependency directions + TypeScript
npm run build
npm test               # the default suite (needs infra:up running and .env)
npm test -- --live     # the suites with the local viewer on
npm test -- --live tests/trash.test.ts   # one file from the live suite
npm run verify         # every check before a push or a deploy, a few minutes
npm run verify -- --print-steps   # the steps; --only=<step,…> runs the chosen ones
```

`npm test` runs `scripts/test-isolated.ts`. The runner creates a random PostgreSQL database and a separate versioned bucket, applies the migrations, runs `tests/default-suite.json` (with `--live`, `tests/live-suite.json`) and deletes only the resources it created. At the end it prints `test-suite.cleanup`, and a failed cleanup fails the run. Your working `DATABASE_URL` and `S3_BUCKET` are never passed to the tests.

`npm run test:live` is shorthand for `npm test -- --live`. Read what the other standalone commands in `package.json` do before you run them: not all of them are isolated the way `npm test` is, and some write to the database in `.env`. Run them only against a local database you can afford to lose.

A server listening on port 4390 does not mean the database and storage are reachable. Check `docker compose ps` and `/api/health`.

GitHub Actions runs the same checks on every pull request and every push to `main` (`.github/workflows/verify.yml`): each step there calls `node scripts/verify.mjs --only=<step>`. Locally, `npm run verify` runs them all. Individual steps: `node scripts/verify.mjs --print-steps` and `--only=<step>`; the licence allowlist and the gitleaks image digest are defined only in `scripts/verify.mjs`. The renderer check is a separate command, `npm run test:renderer-runtime`.

Other developer commands: `npm run check:links` (the Markdown link check alone), `npm run format` (Prettier).

## Interactive viewer

`npm run local:setup` writes `HTML_LIVE_MODE=local` to `.env`, so interactive pages work straight away. To see the static view instead, run `HTML_LIVE_MODE=disabled npm run dev` or change the value in `.env`.

The viewer runs as a separate listener on http://localhost:4391 (`VIEWER_PORT`). The different hostname (`localhost` versus `127.0.0.1`) gives the browser a separate origin. The `local` mode works on loopback only. A hosted installation uses the `production` mode, which needs a separate registrable domain ([HOSTED_VIEWER_DELTA](../HOSTED_VIEWER_DELTA.md), [deploy/hosted/README.md](../../deploy/hosted/README.md), both Russian). The legacy `HTML_LIVE_ENABLED=true` means the same as `HTML_LIVE_MODE=local`.

## Sign-in by e-mailed code

By default `MAIL_MODE=disabled`. On loopback you can set `MAIL_MODE=local`: `/signup` then accepts only made-up addresses in the `.test` zone, and the one-time code appears in `.local/mail/<challenge-id>.json`, not in the HTTP response. Real e-mail needs `MAIL_MODE=smtp` with `SMTP_HOST` and `MAIL_FROM`, plus `SMTP_USER` and `SMTP_PASS` if required (port 587 STARTTLS or 465 TLS). Do not commit e-mails or secrets.

## Connecting a local agent

Create a token on http://127.0.0.1:4390/settings/agents (the «Для разработчиков», For developers, section). The MCP address is `http://127.0.0.1:4390/mcp`. The commands for Codex and Claude Code are in [connect-agents.md](../connect-agents.md) (Russian); use the local address instead of `https://polochka.app`.

Two helpers hand an agent a set of files byte for byte, without the model retyping them:

```bash
# Builds a payload from the chosen files: sizes, SHA-256, base64. OUTPUT must be a new file.
npx tsx scripts/prepare-capture.ts ./my-artifact index.html ./payload.json index.html assets/style.css assets/app.js
# Sends a ready request (with the key and title fields) over MCP; the token comes from POLKA_MCP_TOKEN
npx tsx scripts/capture-via-mcp.ts ./request.json http://127.0.0.1:4390/mcp
```

The payload contains source code, so do not commit it. Bundle limits: 64 files and 5 MiB. Hidden paths and symlinks are rejected.

The HTTP API and the publish CLI work locally like this:

```bash
POLKA_ENDPOINT=http://127.0.0.1:4390 node scripts/polka-publish.mjs report.html --title "Test"
```

## Agent sessions locally

Agent sessions are off until a shelf has a quota ([AGENT_SESSIONS](../specs/AGENT_SESSIONS.md), Russian). To try them, set `AGENT_SESSION_QUOTA_BYTES` in `.env` (for example `1073741824` for 1 GiB per personal shelf), restart `npm run dev`, create a token with the «Сессии агентов» (Agent sessions) permission on the Agents page, then:

```bash
node scripts/polka-sessions.mjs login --endpoint http://127.0.0.1:4390   # reads the token from stdin
node scripts/polka-sessions.mjs preview <session-id>                     # shows what would be sent, sends nothing
node scripts/polka-sessions.mjs sync --since 7d
```

The CLI accepts plain HTTP only for `localhost`, `127.0.0.1` and `[::1]`. It reads your real Claude Code and Codex sessions, so use `preview` first.

## The feed locally

The sources of the «Лента» feed pieces are in `content/editorial/<slug>/`. Seeding the hosted catalogue is done by `scripts/editorial-seed-hosted.ts`; the procedure is in [deploy/hosted/README.md](../../deploy/hosted/README.md).

## Restore checks

`npm run test:restore-guards` checks the identifier constraints and the key encryption without touching the database or S3. It is also part of `npm test`.

The synthetic drill creates temporary source and target databases and buckets on the local PostgreSQL and MinIO, moves a dump and the exact object versions across, closes the old access and deletes only its own resources:

```bash
node --import tsx --env-file=.env scripts/restore-drill.ts --confirm-synthetic
```

This is a regression check of the mechanism, not a production restore. Contract: [specs/RESTORE_DRILL_SPEC.md](../specs/RESTORE_DRILL_SPEC.md). The real restore procedure is in [deploy/RESTORE.md](../../deploy/RESTORE.md) (both Russian).

## Maintenance

`npm run maintenance` runs a one-off cleanup, `npm run maintenance:watch` runs it on a schedule. It removes expired unfinished uploads, sessions, and used or expired sign-in codes. Maintenance never deletes user material.
