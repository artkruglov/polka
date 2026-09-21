# MCP transport, capture, preview, and sharing evidence

This slice mounts stateless Streamable HTTP at the exact `/mcp` path on the
existing Fastify listener. It uses the official MCP v2 packages pinned at
`2.0.0`, supports the 2026-07-28 protocol and the SDK's stateless legacy 2025
path, and authenticates every HTTP request with the existing tenant-bound CLI
token service. The endpoint accepts no session-cookie authentication. Exact
Host, optional Origin, token audience, account, tenant, expiry, revoke, and
scope checks remain server controlled.

The implemented surface includes `polka_context`, tenant metadata
`polka_list`, connection-bound `polka_status`, `polka_capture`, `polka_revise`,
`polka_prepare_preview`, `polka_share`, `polka_revoke_share`, and three guide
resources. Capture and revise call the shared application service for validated
source bytes, durable idempotency, quota and CAS. Preview preparation is an
explicit local-only operation for the exact finalized upload and connection;
status remains read-only and never starts a build. Sharing uses a tenant-wide
operation receipt bound to the exact connection and canonical request; a
revoked, expired, or changed receipt never yields a URL on replay. Web share,
publish, and revoke routes use the same lock-ordered service. List cursors
preserve PostgreSQL microsecond precision.

The `/mcp` route alone accepts an 8 MiB JSON body so a base64 representation of
at most 5 MiB of source fits; other routes retain their existing limits. The
SDK response is wrapped before the Node bridge writes it, so successful
hijacked MCP responses retain `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and the
noindex header. Bearer values are not emitted in responses, logs, tests, or
this file.

## Dependency verification

On 2026-09-20, npm and the official SDK documentation reported version 2.0.0
for `@modelcontextprotocol/server`, `@modelcontextprotocol/fastify`,
`@modelcontextprotocol/node`, and `@modelcontextprotocol/client`. These exact
versions are stored in `package.json` and the lockfile. Primary references:

- https://ts.sdk.modelcontextprotocol.io/v2/serving/fastify.html
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28

## Verification

```sh
npm run test:mcp
```

Result: 4 passed, 0 failed. The suite starts a real TCP listener and uses the
official v2 client. It verifies exact 2026-07-28 negotiation, tools and guide
resources, tenant and connection isolation, stable sub-millisecond pagination,
scope, revoke, Host and Origin rejection, cookie rejection, exact route
matching, unchanged web mutation Origin checks, and security headers observed
through the client's real HTTP fetch path. It also saves the four-file fixture,
recovers status by key, retries the same receipt, saves an exact revision, and
successfully transmits a valid request larger than the app's 5 MiB default
while keeping source below 5 MiB. Sharing coverage includes a discarded first
response followed by exact recovery, changed-request and cross-connection key
conflicts, latest-revision CAS, refusal to republish an active older share,
agent-attributed audit, idempotent revoke, and revoked or expired replay with
`url=null`.

Preview coverage runs capture through prepare and then share. It verifies an
exact retry does not charge derivative quota again, disabling the local live
feature creates no reservation, revocation while the bounded worker is active
prevents ready publication, status only reports the outcome, and source export
is byte-for-byte unchanged before and after preparation.

```sh
npm run test:service-auth
```

Result: 4 passed, 0 failed.

```sh
npm test
```

Result: 63 passed, 0 failed, including the shared agent capture and local
prepare-capture helper suites.

```sh
npm run check
git diff --check
```

Both checks passed after preview wiring. `npm run test:runtime` also passed 3 of
3 tests, covering existing bundle share, publish, grant, and revoke behavior.

## Limits

There is no URL import or OAuth flow. MCP preview preparation is limited to the
local experimental live feature and must be requested explicitly; capture,
status, and sharing never start it implicitly. Hosted preview remains disabled.
The integration uses the official SDK client; command-line clients still need
separate acceptance with actual receipts.

## Actual CLI probes

A bounded local probe used temporary credentials and revoked each connection in
a `finally` cleanup. Codex CLI 0.153.4 connected to the MCP server and read
`polka_context`. Its model then produced an invalid capture payload with the
entrypoint repeated three times and corrupted base64; server validation rejected
it before creating an upload, and the 180-second harness limit ended the run.
This proves the client reached the transport and context tool, but it is not a
successful capture or an end-to-end compatibility acceptance.

Claude Code 2.1.278 reached an account API 429 before the model or any MCP tool
could run, so it created no upload and provides no transport compatibility
evidence. The probe tokens were revoked and no token value was retained here.

These probes ran against the immediately preceding dev process, which used the
same handler and tool implementation with explicit SDK `responseMode: "json"`.
The final source uses the SDK's default `auto` response mode; the official SDK
integration suite above passed against that final setting. The change only
removes the SDK warning and allows its documented automatic JSON/SSE response
selection, so the CLI context probe must not be represented as a probe of the
final response-mode setting.

A later bounded Codex helper probe completed capture of the four-file fixture,
read back an export with exact bytes, and revoked its temporary token. This is
evidence for that concrete local helper path; it does not establish hosted,
URL-import, or OAuth support.
