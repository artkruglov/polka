#!/bin/sh
# Copy of the works bucket in a second bucket the app cannot touch
# (README.md, «Копия работ»). Every MIRROR_INTERVAL_SECONDS the objects of
# S3_BUCKET that the copy lacks are copied into MIRROR_BUCKET inside the store
# (no bytes through this VM), and an object gone from S3_BUCKET gets a delete
# marker there. MIRROR_BUCKET is versioned with object lock: every copied
# version is kept for its retention period whatever happens to S3_BUCKET or
# to this key, and its lifecycle rule removes deleted versions later, so an
# erased account leaves the copy within BACKUP_RETENTION_MAX_DAYS.
# Its own key: read S3_BUCKET, write and delete-marker MIRROR_BUCKET, never
# delete a version.
set -eu

: "${S3_ENDPOINT:?Set S3_ENDPOINT}"
: "${S3_BUCKET:?Set S3_BUCKET}"
: "${MIRROR_BUCKET:?Set MIRROR_BUCKET}"
: "${MIRROR_S3_ACCESS_KEY:?Set MIRROR_S3_ACCESS_KEY}"
: "${MIRROR_S3_SECRET_KEY:?Set MIRROR_S3_SECRET_KEY}"
interval="${MIRROR_INTERVAL_SECONDS:-900}"
max_deletes="${MIRROR_MAX_DELETES:-200}"
for value in "$interval" "$max_deletes"; do
  case "$value" in ''|*[!0-9]*) echo "mirror FAILED: MIRROR_INTERVAL_SECONDS and MIRROR_MAX_DELETES must be integers" >&2; exit 2 ;; esac
done
[ "$S3_BUCKET" != "$MIRROR_BUCKET" ] || { echo "mirror FAILED: MIRROR_BUCKET is S3_BUCKET" >&2; exit 2; }

export AWS_ACCESS_KEY_ID="$MIRROR_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$MIRROR_S3_SECRET_KEY"
export AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"
unset MIRROR_S3_ACCESS_KEY MIRROR_S3_SECRET_KEY
marker=/tmp/last-success
mirror_sync() { aws --endpoint-url "$S3_ENDPOINT" s3 sync --no-progress "s3://$S3_BUCKET" "s3://$MIRROR_BUCKET" "$@"; }

mirror_once() {
  # Deletions are propagated only in a sane amount: a bucket emptied at once
  # (a bug, a stolen app key) is copied without them and reported; the locked
  # versions are there either way.
  deletes=$(mirror_sync --delete --dryrun | grep -c '^(dryrun) delete:' || true)
  if [ "$deletes" -gt "$max_deletes" ]; then
    mirror_sync --only-show-errors || return 1
    echo "mirror ALERT: $deletes objects are gone from $S3_BUCKET since the last copy (limit $max_deletes); copied without deleting, see README.md «Копия работ»" >&2
    return 1
  fi
  mirror_sync --delete --only-show-errors || return 1
  echo "mirror ok $(date -u +%Y%m%dT%H%M%SZ) deletes=$deletes"
  date +%s > "$marker"
}

trap 'exit 0' TERM INT
first=1
while true; do
  if ! mirror_once; then
    echo "mirror FAILED $(date -u +%Y%m%dT%H%M%SZ)" >&2
    [ "$first" = 1 ] && exit 1
  fi
  first=0
  sleep "$interval" &
  wait $! || true
done
