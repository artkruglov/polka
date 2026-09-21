#!/bin/sh
# Nightly logical dump of the metadata DB to the private versioned backups
# bucket. Objects are already versioned in their own bucket.
set -eu
apk add --no-cache postgresql16-client aws-cli >/dev/null
export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_DEFAULT_REGION=ru-central1
while true; do
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  if pg_dump --format=custom --no-owner --dbname="$BACKUP_DATABASE_URL" --file=/tmp/polka.dump \
     && aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors /tmp/polka.dump "s3://$BACKUP_BUCKET/postgres/polka-$stamp.dump"; then
    echo "backup ok $stamp $(stat -c %s /tmp/polka.dump) bytes"
  else
    echo "backup FAILED $stamp" >&2
  fi
  rm -f /tmp/polka.dump
  sleep "${BACKUP_INTERVAL_SECONDS:-86400}"
done
