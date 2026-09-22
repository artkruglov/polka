# Полка (Polka)

**Made it with an agent? Show it to others.**

[Русский](README.md) · [Live demo: polochka.app](https://polochka.app) · [Catalogue](https://polochka.app/discover) · [Docs (Russian)](docs/README.md)

Полка ("the shelf") keeps the reports, pages, prototypes and other artifacts you made with Claude, ChatGPT, Claude Code or Codex outside the chat history. Every work gets versions and a clear link. Recipients don't need a Claude or ChatGPT account, and you can revoke a link at any time.

- **The agent saves it for you.** In Claude.ai and ChatGPT, Полка is a connector: say "save this to Полка" and the reply contains a link (checked by hand with Claude.ai, not yet with ChatGPT; see [status](docs/status.md)). Claude Code, Codex and other MCP clients connect with a token. Scripts and CI use the HTTP API.
- **Interactive pages work for recipients.** React/JSX chat artifacts are compiled into one self-contained page, with libraries bundled in and no network access. The page opens in a sandbox on a separate domain (`polochka.page`).
- **Exact versions.** Every save is immutable and has a SHA-256. A link shows the version you published, not your latest draft.
- **Revocable links.** You can pick how long a link lasts (1, 7 or 30 days), revoke it, and receive reports from recipients. Private works stay out of the catalogue and search indexes.
- **Shelf and templates.** Folders, search, trash and restore. Team template libraries have roles, invitations and an audit log. An agent reads a pinned template version and builds new work from it.

| Home | Catalogue | Shared page |
|---|---|---|
| ![Полка home page](docs/screenshots/landing.png) | ![The «Интересное» catalogue](docs/screenshots/discover.png) | ![An interactive page opened from a link](docs/screenshots/recipient.png) |

> **Status: prerelease.** The latest tag is `v0.1.0-rc.4`. Changes since then are listed in the [CHANGELOG](CHANGELOG.md). A hosted pilot runs at https://polochka.app, and the operator creates the accounts. The API, database schema and UI may still change. What works and what doesn't: [docs/status.md](docs/status.md) (Russian).

The interface and most documentation are in Russian. Identifiers, commands and API fields are in English.

## Four ways to save a work

| From | How | Details |
|---|---|---|
| Claude.ai, ChatGPT | Connector `https://polochka.app/mcp` with OAuth 2.1 sign-in. The model calls `polka_publish` and returns a link | [Connector](docs/MCP_CONNECTOR.md) |
| Claude Code, Codex, other MCP clients | Token from the «Агенты» (Agents) page, Streamable HTTP at `/mcp` | [Connecting agents](docs/connect-agents.md) |
| Scripts, CI, in-house agents | `POST /api/v1/publish` or the dependency-free CLI `scripts/polka-publish.mjs` | [HTTP API](docs/PUBLISH_API.md) |
| By hand | Upload a file (HTML, text, PNG/JPEG/WebP up to 5 MB), or paste code on the «Сохранить» (Save) page | [FAQ](docs/faq.md) |

You can't paste a link to a Claude or ChatGPT artifact. Полка's server can't fetch it (the sites require a login and sit behind Cloudflare), so the app tells you to use the connector, download the file or paste the code instead.

## Quick start

You need Node.js ≥ 22.16, npm and a running Docker.

```bash
git clone https://github.com/artkruglov/polka.git && cd polka
npm ci
npm run local:setup              # .env with unique local secrets
npm run infra:up                 # PostgreSQL 16 + MinIO, bound to 127.0.0.1
npm run db:migrate
npm run storage:bootstrap-local  # versioned bucket and a capability check
npm run account:create -- demo --generate   # login and password in .local/demo-account.txt
npm run build
npm run dev                      # http://127.0.0.1:4390
```

The interactive viewer, e-mail code sign-in and the separate test suites are covered in [docs/local-development.md](docs/local-development.md).

## Checks

```bash
npm run check          # frontend layers + TypeScript
npm run build
npm test               # throwaway database and bucket, removed afterwards
npm test -- --live     # suites that need the local viewer
```

## Limitations

- **Pages are capped at 5 MB and have no network.** Everything must be inside one HTML page or bundle, with styles, images and fonts as `data:` URIs. External scripts, `fetch` and forms don't work for recipients.
- **Interactive mode needs a separate viewer domain.** Without one (`HTML_LIVE_MODE=disabled`), recipients see a static page with scripts off.
- **Claude/ChatGPT links can't be imported.** Save through the connector, download the file or paste the code.
- **Downloaded copies can't be revoked.** Revoking a link closes it, but it can't delete what a recipient already downloaded.
- **The operator creates accounts.** Sign-in is by password. E-mail sign-in works only with SMTP configured. There's no SSO/SCIM.
- **URL import** (`URL_IMPORT_ENABLED`) and **account deletion** (`ACCOUNT_DELETION_ENABLED`) are off by default.

More: [docs/faq.md](docs/faq.md) (Russian).

## Self-hosting

A deployment is one Docker image plus external PostgreSQL and versioned S3 storage. You build the image from source (`docker build`); no published image exists yet. The interactive viewer must run on a separate registrable domain. The recommended path is [deploy/hosted/README.md](deploy/hosted/README.md): a single VM behind Caddy, which is how polochka.app runs. [deploy/BASE.md](deploy/BASE.md), [deploy/RESTORE.md](deploy/RESTORE.md) and [deploy/VIEWER_STAGING.md](deploy/VIEWER_STAGING.md) are drafts for experienced operators. For how the parts fit together, see [docs/architecture.md](docs/architecture.md).

## Documentation

In Russian: [Document map](docs/README.md) · [Architecture](docs/architecture.md) · [Connecting agents](docs/connect-agents.md) · [FAQ](docs/faq.md) · [Status](docs/status.md) · [Roadmap](docs/roadmap.md) · [Changes](CHANGELOG.md)

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). See also [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The project grew out of [Lanka](https://github.com/artkruglov/lanka); see [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).
