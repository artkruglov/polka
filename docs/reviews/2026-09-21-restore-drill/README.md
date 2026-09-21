# Synthetic restore drill evidence

This evidence covers the bounded local mechanism in
`scripts/restore-drill.ts`. It is not a production backup/restore acceptance and
does not establish the beta RPO or RTO.

## Isolation and safety

The drill derived one unique pair of PostgreSQL database names under
`polka_restore_drill_<id>_{source,target}` and one unique pair of buckets under
`polka-restore-drill-<id>-{source,target}`. Before any write it required:

- loopback PostgreSQL and S3 endpoints;
- no URL query/hash routing overrides such as PostgreSQL `?host=`;
- exact synthetic prefixes and role suffixes;
- source, target, working database, and working bucket identities to differ;
- both synthetic databases and buckets to be absent;
- an explicit `--confirm-synthetic` argument.

Database comments and a versioned bucket sentinel bound cleanup to the exact
current run. Cleanup refused unknown identities. The working `polka` database
and configured working bucket were neither source nor target and were not read
as application data.

The drill used `pg_dump` and `pg_restore` from the existing local PostgreSQL
container. It did not build a Docker image. Secrets and tokens were passed only
through process memory/environment and were not written to stdout. The
synthetic `LINK_KEY` was stored in the temporary backup as authenticated
AES-256-GCM ciphertext, checked by fingerprint, then removed with the temporary
directory.

## Scenario

The synthetic source contained a single HTML revision, a four-file bundle, a
ready inline derivative, one still-live staged object, one reconciled bundle
tombstone with dead `upload_files` metadata, active and already-revoked shares,
an owner session, short grants, an agent connection, a connection-bound capture
receipt, a real agent share operation receipt, and quota counters.

The script:

1. created a custom-format database dump and a checksum-verified logical object
   archive from live DB references;
2. verified the backup envelope and loaded object references back from its
   JSONL manifest rather than reusing the in-memory source list;
3. proved positive source status/capture/share replays through the real service
   functions without duplicate rows or quota changes;
4. changed the synthetic source after the snapshot by revoking its active share
   and agent connection and deleting its session;
5. restored the older dump into a new database and exact bytes into a new
   versioned bucket;
6. required every target VersionId to differ from its source VersionId and
   atomically remapped all five reference locations;
7. removed only dead reconciled `upload_files` while preserving the upload
   tombstone;
8. applied the mandatory fail-closed transaction before starting the target
   app checks;
9. reread every target object by exact key and remapped VersionId, validating
   size and SHA-256, manifest hashes, and unchanged source/derivative quotas;
10. recomputed every restored share token hash through the real `tokenFor`,
    checked rejected stale agent status/capture/share replays left rows and
    quotas unchanged, then used a fresh password login for exact source/export;
11. created one explicit new static share, resolved it to the expected revision,
    and confirmed all old recipient tokens remained denied;
12. ran maintenance only against the target, confirmed it deleted the exact
    staged target version while preserving its tombstone, every committed
    object/quota, and the source staged version;
13. removed only the sentinel-authorized synthetic resources.

## Commands and results

```sh
npx tsx --test tests/restore-drill.test.ts
```

Result: 3 passed, 0 failed. The tests cover exact name/prefix separation,
rejection of URL query routing overrides before writes, and authenticated
secret escrow, including tamper rejection.

```sh
npm run check
```

Result: passed.

```sh
node --import tsx --env-file=.env scripts/restore-drill.ts \
  --confirm-synthetic > .local/restore-drill-result.json
```

Final result:

```json
{
  "drill": "synthetic-local",
  "backupId": "2609200c534683",
  "schemaVersion": 12,
  "objectReferences": 7,
  "remappedVersions": 7,
  "oldRecipientStatus": 404,
  "previouslyRevokedRecipientStatus": 404,
  "oldSessionStatus": 401,
  "oldAgentDenied": true,
  "shareTokenHashesVerified": true,
  "freshOwnerLogin": true,
  "ownerSourceAndExportExact": true,
  "explicitNewShare": true,
  "rejectedAgentReplaysStable": true,
  "maintenance": {
    "stagedTargetDeleted": true,
    "stagedSourcePreserved": true,
    "committedReferencesPreserved": true,
    "quotaPreserved": true
  },
  "quotaBytes": { "used": 287, "derivative": 56 },
  "elapsedMs": 1527,
  "sourceMutatedAfterSnapshot": true,
  "failClosed": true,
  "productionRestoreProven": false
}
```

Post-run prefix scans found no remaining drill databases or buckets.

The final acceptance assertions require revoked agent calls to fail with the
exact service `Problem(401, "unauthorized")`; unrelated runtime or database
errors fail the drill. After target maintenance, the script also compares the
complete `(role, key, VersionId, size, SHA-256)` reference multiset against the
restored mapping with only the expected staged upload removed before rereading
every committed object.

A read-only review found that checking `URL.hostname` alone did not
exclude PostgreSQL query routing such as
`postgresql://...@127.0.0.1/db?host=example.test`. The drill now rejects every
nonempty search/hash component before writes, and the exact bypass has a pure
regression test. The later full acceptance run above executed with this guard.

An earlier bounded run exposed MinIO returning additional versions after a
non-truncated delete pass. Cleanup now verifies its sentinel once, repeatedly
lists from the start with a fixed pass bound, and deletes the bucket only after
an empty listing. The one residual exact synthetic bucket from that diagnostic
run was identified by its recorded run name, removed without touching other
buckets, and absence was confirmed before the final run.

## Limits

Both synthetic databases used one local PostgreSQL server and both buckets used
one local MinIO service; identity and VersionId remapping were separate, but
this did not test provider migration, managed PostgreSQL PITR, encrypted remote
backup retention, production data volume, DNS cutover, RPO, or RTO. The script
is a local regression drill and must not be pointed at hosted or working data.

## Schema14 maintenance rerun

После подключения guarded maintenance тот же bounded drill повторён для
текущего каталога миграций1–14. Команда выполнялась без перенаправления stdout,
чтобы единственный итоговый JSON был наблюдаемым:

```sh
npx tsx --env-file=.env scripts/restore-drill.ts --confirm-synthetic
```

Результат run `26092084b16996`: exit0, schemaVersion14, 7 DB object references,
7 remapped VersionIds, quota `used=287` и `derivative=56`. Maintenance на
synthetic target выдал только `maintenance.started` и
`maintenance.completed`; committed counters были uploads1, derivatives0,
email0. Staged target object удалён, source staging сохранился, полный multiset
committed references и quota не изменились. Остальные fail-closed, owner,
recipient, agent replay и trash assertions остались true.

После проверки script повторно проверил отсутствие обеих созданных DB и обоих
buckets; итог содержит `syntheticResidueRemoved:true`. DSN, credentials,
tokens, object bytes и filenames пользователя не сохранялись. Это не
production restore proof и не проверка hosted provider/RPO/RTO.
