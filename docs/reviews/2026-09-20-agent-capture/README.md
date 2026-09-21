# Agent capture service (not yet exposed as MCP tools)

Shared upload logic is extracted into six InTransaction functions; web wrappers
retain signatures and results. PUT now takes tenant before upload, matching
finalize and the service actor transaction. Source storage is not duplicated.

Migrations010/011 are applied locally. Uploads bind to connection+tenant+account;
audit records agent identity without token/content. `captureFromAgent` validates
the whole selected package, then durably begins, uploads and finalizes in separate
transactions. Each step rechecks scope/revoke. `statusForAgent` accepts key XOR
uploadId and exposes only that connection's operations.

Acceptance on 2026-09-20:
- `npx tsx --env-file=.env --test tests/agent-capture.test.ts`: 1 passed. Actual DB/S3
  four-file export equality, idempotent receipt, foreign connection conflict/status
  denial, invalid base64 before reservation, revision2, agent audit and revoked replay.
- `npm test`: 60 passed after shared refactor/migrations.
- `npm run check` and `git diff --check`: passed.

Astra review found missing status-by-key recovery. Fixed and tested; an interrupted
caller can query using its original key without resending source bytes.

Remaining: wire capture/revise/status tools, test on real MCP transport and two CLI
clients, add atomic share receipt/service and agent-compatible derivative preparation.
HTTP body limit must be8MiB for base64 envelope; source limit remains5MiB.
This evidence does not claim those remaining features or cloud readiness.
