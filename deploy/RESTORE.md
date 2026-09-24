# Restore target candidate — not production

This runbook describes the current restore barrier for an already restored, dedicated, **closed** target. It is an operator draft. It does not provision PostgreSQL/S3, create roles, produce a backup, or claim hosted deletion or production restore readiness.

## Required inputs

Prepare an exact backup descriptor file and a separate erasure-ledger manifest authority. The descriptor must be a regular file, be no larger than the runner limit, declare `formatVersion: 1`, the exact migration list for this release (the exact set is in `packages/migrations.ts`, currently up to 034), the expected `erasureLedgerId`, and `localMailSpool: "absent"`. The operator must independently attest that the target host has no local mail spool; the descriptor field is checked but does not inspect the host filesystem.

Provide these exact values through a protected operator environment file or secret manager, never as command-line arguments:

- a fresh `RESTORE_RUN_ID` UUID for each restore generation;
- `RESTORE_BACKUP_SHA256`, computed over the descriptor bytes;
- `RESTORE_LEDGER_MANIFEST_SHA256`, computed over the canonical loaded ledger records;
- the descriptor path and a receipt directory outside the descriptor's backup directory;
- `DATABASE_URL` for the runtime identity and a distinct `RESTORE_DATABASE_URL` for the restore LOGIN;
- separate content-storage and read-only erasure-ledger credentials and buckets.

The runtime and restore URLs must target the same database endpoint/name while using different named logins. The restore login must be an unprivileged dedicated identity. The ledger bucket and credentials must be separate from content storage and must not be writable by the restore process. The target must be closed: stop app, maintenance, purge and other clients, and bind the restore receipt directory to the image's `node` UID with write permission. Mount the backup descriptor read-only.

The current code verifies the descriptor hash, schema list, ledger ID and ledger manifest hash before reconciliation. There is no supported command in this repository that generates a backup descriptor or the ledger manifest hash from an arbitrary backup. The manifest hash is a library/runner authority value; do not invent a shell pipeline or substitute a hash of the descriptor.

## Sequence

1. Confirm the target is dedicated and closed. `restore-target.ts` checks current/session identity, exact database name, no other sessions and the complete reviewed migration sequence.
2. Confirm the backup descriptor, exact byte hash, ledger ID and manifest hash out of band. Create the receipt directory outside the backup directory and make it writable by the container's `node` UID. Do not create the receipt inside the backup tree.
3. Apply the reviewed schema-owner/runtime/purge/restore role recipes separately. The restore role must be distinct from both runtime and ordinary purge worker; it receives only the reviewed restore function signatures and SELECT on schema_migrations. Schema-owner credentials belong only to the migration job; do not pass them to the app or restore-reconcile job.
4. Run the one-shot `restore-reconcile` service from `deploy/compose.restore.yml` with `--confirm-closed-target`. It loads the erasure ledger before reconciliation, checks the exact backup/ledger authorities, runs the restore reconciliation, and writes a completion receipt only after the guarded operation completes.
5. Inspect the structured completion result and receipt without copying secrets. Start only the app and its dependencies through the compose restore dependency after the restore service has completed successfully. Do not start the entire stack before review: that would also start maintenance once app is healthy. Keep maintenance/purge stopped until the normal post-restore review is complete.

The receipt is the handoff barrier, not a backup. It binds the fresh restore generation, backup hash, target identity, schema manifest, ledger ID and ledger manifest hash. Keep it outside the backup and do not edit it. A failed run must not be converted into success by manually creating or editing a receipt.

Render both compose files with the protected environment file before running any service; rendered values may contain secrets. Use `config -q` for validation. When proceeding, select the `app` service explicitly so the unrelated maintenance service is not started automatically. The overlay must be combined with `compose.base.yml`; it is not a standalone deployment.

## Retry and evidence

Retrying the same generation is appropriate only after inspecting the failed run and preserving its exact authorities; use the same `RESTORE_RUN_ID` when resuming an interrupted reconciliation. Start a new generation with a new UUID for a different backup, target, or intentionally new restore attempt. Do not reuse a completed receipt or silently overwrite an existing generation.

The operational CLI and actual application startup gate also passed an isolated local run with a distinct read-only MinIO identity. Container startup remains unaccepted.

The full-backup evidence is synthetic/local: the full schema 018 restore run recorded exact remapped references, old recipient/session denial, source and metadata erasure, preserved historic receipt, and residue cleanup. It reports `productionRestoreProven: false`; it is not evidence of production backup retention, cloud IAM, container startup, or hosted deletion.

The compose overlay keeps the application live/hosted viewer disabled for this base shape. A real operator acceptance still needs a reviewed backup source, production role grants, retention/rollback policy and a controlled restore drill on the selected deployment.
