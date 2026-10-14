#!/bin/sh
# Prepares a database directory for a restore to a moment in time
# (README.md, «Восстановление на момент времени»): the newest base backup
# from BACKUP_BUCKET/base/ that finished before the target, the WAL archive
# from BACKUP_BUCKET/wal/, and the recovery settings. PostgreSQL then replays
# the WAL up to the target when it starts on this directory and opens the
# database for writing.
#
#   polka-pitr-restore --target 2026-10-14T09:30:00Z [--base <UTC>] [--list]
#   polka-pitr-restore --target latest
#
# Run with the pgdata volume mounted empty at /var/lib/postgresql/data and a
# key that may read BACKUP_BUCKET (not the write-only backup key) in
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
set -eu

: "${S3_ENDPOINT:?Set S3_ENDPOINT}"
: "${BACKUP_BUCKET:?Set BACKUP_BUCKET}"
pgdata="${PGDATA:-/var/lib/postgresql/data}"
target=""
base=""
list=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --list) list=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
s3() { aws --endpoint-url "$S3_ENDPOINT" s3 "$@"; }

bases=$(s3 ls "s3://$BACKUP_BUCKET/base/" | awk '$1 == "PRE" { sub("/$", "", $2); print $2 }' | sort)
if [ "$list" = 1 ]; then
  echo "base backups (UTC, finished):"
  echo "$bases"
  echo "newest WAL:"
  s3 ls "s3://$BACKUP_BUCKET/wal/" | sort | tail -3
  exit 0
fi
case "$target" in
  latest) stamp=99999999T999999Z ;;
  ????-??-??T??:??:??Z) stamp=$(echo "$target" | tr -d ':-') ;;
  *) echo "--target: UTC time like 2026-10-14T09:30:00Z, or latest" >&2; exit 2 ;;
esac
if [ -z "$base" ]; then
  base=$(echo "$bases" | awk -v t="$stamp" '$0 != "" && $0 <= t' | tail -1)
fi
[ -n "$base" ] || { echo "no base backup finished before $target" >&2; exit 1; }
if [ -n "$(ls -A "$pgdata" 2>/dev/null)" ]; then
  echo "$pgdata is not empty: restore into an empty volume" >&2
  exit 1
fi
echo "base backup $base, target $target"

work=$(mktemp -d)
s3 cp --recursive --only-show-errors "s3://$BACKUP_BUCKET/base/$base/" "$work/base/"
mkdir -p "$pgdata"
chmod 700 "$pgdata"
tar -xzf "$work/base/base.tar.gz" -C "$pgdata"
rm -rf "$work/base"

# The WAL archive, unpacked where restore_command finds it. A segment that
# was still being written has only its `.partial` copy: it stands in for the
# segment (PostgreSQL replays it up to where the bytes end).
archive="$pgdata/pitr-wal"
mkdir -p "$archive"
s3 sync --only-show-errors "s3://$BACKUP_BUCKET/wal/" "$work/wal/"
for file in "$work"/wal/*.gz; do
  [ -e "$file" ] || continue
  name=$(basename "$file" .gz)
  case "$name" in *.partial) continue ;; esac
  gunzip -c "$file" > "$archive/$name"
done
for file in "$work"/wal/*.partial.gz; do
  [ -e "$file" ] || continue
  name=$(basename "$file" .partial.gz)
  [ -e "$archive/$name" ] || gunzip -c "$file" > "$archive/$name"
done
rm -rf "$work"
echo "WAL segments: $(ls "$archive" | wc -l)"

{
  echo "# polka-pitr-restore $(date -u +%Y-%m-%dT%H:%M:%SZ): remove after the restore (README.md)"
  echo "restore_command = 'cp $archive/%f \"%p\"'"
  echo "recovery_target_timeline = 'latest'"
  if [ "$target" != latest ]; then
    echo "recovery_target_time = '$(echo "$target" | sed 's/T/ /; s/Z$/+00/')'"
    echo "recovery_target_action = 'promote'"
  fi
} >> "$pgdata/postgresql.auto.conf"
touch "$pgdata/recovery.signal"
echo "ready: start postgres on this volume and wait for «database system is ready to accept connections»"
