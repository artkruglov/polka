# Contributing

*Русская версия: [CONTRIBUTING.ru.md](CONTRIBUTING.ru.md).*

Thank you for your interest in Полка (Polka). The project is in prerelease, so the API, the database schema and the interface may change. Issues and pull requests are welcome in Russian or English. The product and the main README are Russian-first; the developer documentation is in English: [docs/en/](docs/en/README.md).

## Before you start

- For a large change, open an issue first and describe the user's problem it solves.
- Report vulnerabilities privately only, see [SECURITY.md](SECURITY.md).
- The product boundaries are in [docs/specs/PRODUCT.md](docs/specs/PRODUCT.md) (Russian). Полка stores and shows what agents make; it does not generate anything itself. What is done and what is planned: [docs/status.md](docs/status.md), [docs/roadmap.md](docs/roadmap.md) (Russian).
- Participants follow the [code of conduct](CODE_OF_CONDUCT.md).

## Running locally

You need Node.js ≥ 22.16, npm and Docker. Details: [docs/en/local-development.md](docs/en/local-development.md).

```bash
npm ci
npm run local:setup              # .env with local secrets and the local interactive viewer
npm run infra:up                 # PostgreSQL and MinIO in Docker, on 127.0.0.1 only; the first run builds MinIO, ~10 min
npm run db:migrate
npm run storage:bootstrap-local
npm run account:create -- demo --generate
npm run build
npm run dev                      # http://127.0.0.1:4390
```

## Checks before a pull request

```bash
npm run check          # frontend layers, formatting (Prettier), lint (oxlint, .oxlintrc.json) + TypeScript; npm run format fixes the formatting
npm run build
npm test               # throwaway database and bucket, removed after the run
npm test -- --live     # the files in tests/live-suite.json, with the viewer on
```

`npm test -- --live` is required if your change touches the viewer, the bundle builder, the runtime, the trash or the «Лента» feed. To run one file: `npm test -- --live tests/trash.test.ts`. `npm run test:live` is the same as `npm test -- --live`. The other standalone commands (`test:restore-guards`, `test:url-import-runtime` and the rest in `package.json`) are described in [docs/en/local-development.md](docs/en/local-development.md).

Run `npm run verify` before opening a pull request. GitHub Actions runs the same steps on every pull request and every push to `main` (`.github/workflows/verify.yml`); running them locally just shows a failure sooner. In order, `verify` runs `check`, the documentation link check, `build`, `npm test`, `npm test -- --live`, the database role grants check (`scripts/test-runtime-grants-isolated.ts`), the licences of production dependencies and secrets in the history (gitleaks in Docker), and builds the application and backup Docker images. `npm run verify -- --quick` runs only types, links, the build and the default test suite; `--print-steps` lists the steps, `--only=<step,…>` runs the chosen ones. The `grants` step of a full run expects MinIO on the default port 9038 and refuses any other.

## Rules

- **Frontend layers.** `apps/web/src` is split into the layers `app → pages → widgets → features → entities → shared`, and imports may only point down. Slices of one layer (two pages, say) do not import each other; `shared` and `app` are the exception. From outside `apps/web/src` only `packages/contracts`, `packages/editorial.ts` and the `docs/legal/*.md` texts (through `?raw`) are allowed. `npm run check:layers` checks all of this. Shared components and tokens live in `shared/ui`; see [docs/FRONTEND_COMPONENT_SYSTEM.md](docs/FRONTEND_COMPONENT_SYSTEM.md) (Russian).
- **Contracts.** Schemas and limits shared by the server and the client live in `packages/contracts` (zod).
- **One service per action.** The web UI, MCP and the publish API call the same services in `apps/server`. Do not repeat tenant, scope or idempotency checks in a transport.
- **Schema.** The schema changes only through a new migration in `deploy/migrations/` (existing migrations are never edited) plus an update to `packages/migrations.ts`. New privileges for the runtime role go into `deploy/runtime-grants.sql`.
- **Runtime.** A new library in `packages/contracts/runtime.ts` needs an entry in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and a licence from the list that `npm run verify` allows.
- **Secrets.** Do not commit `.env`, `.local/`, dumps, user files, tokens or keys.
- **Documentation.** A change in behaviour updates the relevant document in `docs/`, [docs/status.md](docs/status.md) and the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md).
- **Formatting:** `npm run format`.

## Commits, pull requests and releases

- **Every change goes through a pull request**, the maintainer's own included. CI (`.github/workflows/verify.yml`, which runs the `scripts/verify.mjs` steps) must be green before a merge. Pull requests are squash-merged.
- **Commit subject:** `area: what changed`, at most 72 characters, imperative or descriptive, in English. For example `viewer: refuse grants for a deleted revision` or `docs: English local development guide`. The reason and the details go in the body.
- **Releases** are tagged `vX.Y.Z` ([SemVer](https://semver.org/)). The release title is in English: `vX.Y.Z — short summary`. Patch fixes are batched into one release rather than several releases a day. Release notes go into [CHANGELOG.md](CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)).

## Licence and CLA

Полка is distributed under the [AGPL-3.0](LICENSE) and under a [commercial licence](COMMERCIAL.md#open-core-and-commercial-edition-summary-in-english) (dual licensing). Pull requests are accepted under the AGPL-3.0 and the [Contributor License Agreement (CLA)](CLA.md#contributor-license-agreement-english-translation). Under the CLA you keep the copyright in your contribution, and the maintainer receives a perpetual, irrevocable licence to it, patent licence included, and the right to distribute it under other terms, commercial ones included. Dual licensing does not work without that right.

To accept the CLA, write "I accept the CLA (CLA.md)" in the pull request description, or tick that box in the pull request template. Once is enough: the agreement also covers your later contributions. A pull request without an accepted CLA is not merged.

Versions up to and including v0.1.0-rc.5 remain available under Apache-2.0.
