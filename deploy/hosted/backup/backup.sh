#!/bin/sh
# Periodic logical dump of the metadata DB to the private, versioned backups
# bucket (objects are already versioned in their own bucket). Uses its own
# write-only S3 key when configured. Fails loudly: a misconfiguration or a
# failed first backup exits non-zero (visible in `docker compose ps`), and the
# healthcheck turns unhealthy when no backup succeeded within the interval.
set -eu

: "${BACKUP_DATABASE_URL:?Set BACKUP_DATABASE_URL}"
: "${S3_ENDPOINT:?Set S3_ENDPOINT}"
: "${BACKUP_BUCKET:?Set BACKUP_BUCKET}"
: "${BACKUP_S3_ACCESS_KEY:?Set BACKUP_S3_ACCESS_KEY}"
: "${BACKUP_S3_SECRET_KEY:?Set BACKUP_S3_SECRET_KEY}"
interval="${BACKUP_INTERVAL_SECONDS:-86400}"
case "$interval" in ''|*[!0-9]*) echo "backup FAILED: BACKUP_INTERVAL_SECONDS must be an integer" >&2; exit 2 ;; esac

export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"
export AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"
unset BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
dump=/tmp/polka.dump
marker=/tmp/last-success

backup_once() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  rm -f "$dump"
  pg_dump --format=custom --no-owner --dbname="$BACKUP_DATABASE_URL" --file="$dump" || return 1
  # A dump that pg_restore cannot list is not a backup.
  pg_restore --list "$dump" >/dev/null || return 1
  aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "$dump" \
    "s3://$BACKUP_BUCKET/postgres/polka-$stamp.dump" || return 1
  echo "backup ok $stamp $(stat -c %s "$dump") bytes"
  date +%s > "$marker"
  rm -f "$dump"
}

first=1
while true; do
  if ! backup_once; then
    rm -f "$dump"
    echo "backup FAILED $(date -u +%Y%m%dT%H%M%SZ)" >&2
    # The first attempt runs at `up`: surface a broken setup immediately.
    [ "$first" = 1 ] && exit 1
  fi
  first=0
  sleep "$interval"
done
