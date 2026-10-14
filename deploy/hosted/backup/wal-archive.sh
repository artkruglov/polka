#!/bin/sh
# Continuous archive of the database's write-ahead log, for a restore to any
# minute (README.md, «Восстановление на момент времени»). pg_receivewal
# streams the WAL over a replication connection into the spool volume through
# a replication slot, so the server keeps what was not received yet; every
# WAL_UPLOAD_SECONDS the finished segments go to BACKUP_BUCKET/wal/ (gzip) and
# leave the spool, and the segment being written goes up as `<name>.partial.gz`
# whenever it changed: that is what bounds the loss to about a minute. Every
# BASE_BACKUP_INTERVAL_SECONDS a physical base backup (pg_basebackup) goes to
# BACKUP_BUCKET/base/<UTC>/; a restore starts from one and replays the WAL.
# The same write-only key as the dumps (PutObject under wal/ and base/).
set -eu

: "${PGHOST:?Set PGHOST}"
: "${PGUSER:?Set PGUSER}"
: "${S3_ENDPOINT:?Set S3_ENDPOINT}"
: "${BACKUP_BUCKET:?Set BACKUP_BUCKET}"
: "${BACKUP_S3_ACCESS_KEY:?Set BACKUP_S3_ACCESS_KEY}"
: "${BACKUP_S3_SECRET_KEY:?Set BACKUP_S3_SECRET_KEY}"
if [ -z "${PGPASSWORD:-}" ]; then
  echo "wal-archive FAILED: POLKA_REPLICA_PASSWORD is not set (README.md, «Восстановление на момент времени»)" >&2
  exit 2
fi
upload_every="${WAL_UPLOAD_SECONDS:-60}"
base_every="${BASE_BACKUP_INTERVAL_SECONDS:-86400}"
for value in "$upload_every" "$base_every"; do
  case "$value" in ''|*[!0-9]*) echo "wal-archive FAILED: WAL_UPLOAD_SECONDS and BASE_BACKUP_INTERVAL_SECONDS must be integers" >&2; exit 2 ;; esac
done
slot="${WAL_SLOT:-polka_wal}"

export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"
export AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"
unset BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY

spool=/var/lib/polka-wal
wal="$spool/wal"
marker=/tmp/last-success
mkdir -p "$wal" "$spool/state"

put() { aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "$1" "s3://$BACKUP_BUCKET/$2"; }

# The slot outlives this container: WAL the server wrote while the archive was
# down waits in the server's pg_wal. Its size is capped by the server's
# max_slot_wal_keep_size (compose.yml): past it the slot is dropped rather
# than the disk filled, and the next base backup starts a new chain.
pg_receivewal --slot="$slot" --create-slot --if-not-exists --no-password
# A slot the server invalidated (past max_slot_wal_keep_size) cannot stream:
# drop it and start over from the current position, with a base backup.
if [ "$(psql -XAt -d postgres -c "SELECT wal_status FROM pg_replication_slots WHERE slot_name='$slot'" 2>/dev/null || true)" = lost ]; then
  echo "wal-archive: slot $slot was lost, starting a new chain" >&2
  pg_receivewal --slot="$slot" --drop-slot --no-password
  pg_receivewal --slot="$slot" --create-slot --no-password
  rm -f "$wal"/* "$spool/state/base-at"
fi

pg_receivewal --directory="$wal" --slot="$slot" --status-interval=10 --no-loop --no-password &
receiver=$!
trap 'kill "$receiver" 2>/dev/null; wait "$receiver" 2>/dev/null; exit 0' TERM INT

upload_round() {
  # Finished segments and timeline history files, oldest first.
  for file in $(ls "$wal" | grep -v -e '\.partial$' -e '\.tmp$' | sort); do
    gzip -c "$wal/$file" > /tmp/wal.gz || return 1
    put /tmp/wal.gz "wal/$file.gz" || return 1
    rm -f "$wal/$file" /tmp/wal.gz
  done
  # The segment being written, when it changed since the last round. After a
  # restore the previous timeline's partial segment stays behind: it goes up
  # once more and leaves the spool.
  newest=$(ls "$wal" | grep '\.partial$' | sort | tail -1)
  for file in $(ls "$wal" | grep '\.partial$'); do
    sum=$(cksum < "$wal/$file")
    if [ "$sum" != "$(cat "$spool/state/$file.sum" 2>/dev/null)" ]; then
      gzip -c "$wal/$file" > /tmp/wal.gz || return 1
      put /tmp/wal.gz "wal/$file.gz" || return 1
      echo "$sum" > "$spool/state/$file.sum"
      rm -f /tmp/wal.gz
    fi
    [ "$file" = "$newest" ] || rm -f "$wal/$file" "$spool/state/$file.sum"
  done
  for sum in "$spool"/state/*.partial.sum; do
    [ -e "$sum" ] || continue
    [ -e "$wal/$(basename "$sum" .sum)" ] || rm -f "$sum"
  done
  # The heartbeat the app's /api/ops/status reads (it may only list the
  # bucket): refreshed every five minutes while the rounds succeed, also when
  # the database is idle and no WAL changed.
  now=$(date +%s)
  if [ $(( now - $(cat "$spool/state/heartbeat-at" 2>/dev/null || echo 0) )) -ge 300 ]; then
    echo "$now" > /tmp/heartbeat
    put /tmp/heartbeat wal/heartbeat || return 1
    echo "$now" > "$spool/state/heartbeat-at"
  fi
  date +%s > "$marker"
}

base_backup() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  dir="$spool/base"
  rm -rf "$dir"
  # Tar format with the WAL the backup needs inside it (-X fetch): a base
  # backup restores on its own even if the WAL archive misses a segment.
  pg_basebackup --pgdata="$dir" --format=tar --gzip --wal-method=fetch \
    --checkpoint=fast --no-manifest --no-password --label="polka-$stamp" || return 1
  # Named after the moment it finished: a restore target after this moment
  # can start from it.
  done_at=$(date -u +%Y%m%dT%H%M%SZ)
  for file in "$dir"/*; do
    put "$file" "base/$done_at/$(basename "$file")" || return 1
  done
  echo "base backup ok $done_at $(du -sk "$dir" | cut -f1) KiB"
  rm -rf "$dir"
  date +%s > "$spool/state/base-at"
}

while kill -0 "$receiver" 2>/dev/null; do
  if ! upload_round; then
    rm -f /tmp/wal.gz
    echo "wal upload FAILED $(date -u +%Y%m%dT%H%M%SZ)" >&2
  fi
  last_base=$(cat "$spool/state/base-at" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - last_base )) -ge "$base_every" ]; then
    base_backup || { rm -rf "$spool/base"; echo "base backup FAILED $(date -u +%Y%m%dT%H%M%SZ)" >&2; }
  fi
  sleep "$upload_every" &
  wait $! || true
done
wait "$receiver" || true
echo "wal-archive FAILED: pg_receivewal stopped" >&2
exit 1
