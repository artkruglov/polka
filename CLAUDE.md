# Полка — notes for coding agents

Полка stores and shows what agents make (pages, projects, sessions); it never generates content itself. The product, UI texts and the main README are Russian; code, commit messages and developer docs are English.

Setup, checks and rules are in [CONTRIBUTING.md](CONTRIBUTING.md) — read it before the first change. This file lists only what agents keep tripping over.

## Map

- `apps/server` — Fastify app: one service per action, shared by the web UI, MCP (`/mcp`) and the publish API.
- `apps/web/src` — React, layers `app → pages → widgets → features → entities → shared` (`npm run check:layers`). Public site pages use `widgets/site-header` and `mkt-*` classes, not `site-*`.
- `apps/renderer` — snapshots and PDF. `packages/contracts` — zod schemas shared by server and client.
- `deploy/migrations` + `packages/migrations.ts` — schema; `deploy/*-grants.sql` — role recipes.
- `scripts/` — CLIs and operator tools; `scripts/polka-sessions.mjs` is the agent-sessions hook/CLI.
- `skills/`, `.claude-plugin/`, `.codex-plugin/`, `.mcp.json` — the agent plugin.
- `docs/specs/` — product specs (Russian); `DECISIONS.md` records why. `docs/status.md` — what works now.
- Commercial features live in a separate private extension; the core only gets extension points (`docs/specs/EXTENSIONS.md`).

## Commands

```bash
npm run infra:up && npm run dev     # PostgreSQL 127.0.0.1:54388, MinIO :9038, app http://127.0.0.1:4390
npm run check                       # layers, prettier, oxlint, tsc
npm test                            # throwaway DB and bucket; needs Docker running
npm test -- --live tests/x.test.ts  # one file of the live suite
npm run verify                      # what CI runs; --quick for a short pass
```

## Gotchas

- **New migration:** besides `packages/migrations.ts`, bump all three recipes `deploy/runtime-grants.sql`, `purge-worker-grants.sql`, `restore-worker-grants.sql` (the "001 through NNN" check and the count), plus `tests/migrations.test.ts`. Otherwise the `grants` step fails on CI and on deploy.
- **Plugin changes** (`skills/`, plugin manifests, `.mcp.json`, a release): the installable plugin is a generated light repo — `node scripts/plugin-repo.mjs <checkout of polka-plugin>`, then commit there.
- **Local sign-in:** use `127.0.0.1`, not `localhost` (origin check; `localhost:4391` is the viewer). Demo login is in `.local/demo-account.txt`; email codes land in `.local/mail/*.json`. `/api/login` rate-limits after ~10 logins — reuse one cookie in scripted checks.
- **Docker on macOS:** if BuildKit hangs at "load metadata" (`docker-credential-desktop`), point `DOCKER_CONFIG` at a dir with `{}` as `config.json` and symlinks to `~/.docker/cli-plugins` and `contexts`.
- **Screenshots:** playwright-core from `node_modules` with `executablePath` of the installed Chrome; for mobile `newContext({viewport:{width:390,height:844},isMobile:true})`.
- **Never commit** `.env`, `.local/`, dumps, real agent sessions or user files. Real sessions are never demo data, even "scrubbed" — use generated fixtures.

## Workflow

- Every change goes through a PR, squash-merged; subject `area: what changed` (≤72 chars, English).
- A behaviour change updates its doc in `docs/`, `docs/status.md` and `CHANGELOG.md` → `Unreleased`.
- Open work is tracked in GitHub Issues (`status:ready` = can be picked up; `blocked-owner` / `blocked-pilot` = waiting on a decision).
