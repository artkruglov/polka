#!/bin/sh
# Point-in-time restore drill on a running installation: restores the base
# backup and WAL from BACKUP_BUCKET into a throwaway volume, starts PostgreSQL
# on it without a network and compares the copy with the live database. The
# live containers are only read; the drill volume is removed on exit.
#
#   cd /opt/polka/deploy/hosted
#   AWS_ACCESS_KEY_ID=<reader> AWS_SECRET_ACCESS_KEY=<secret> sh pitr-drill.sh [--target <UTC>]
#
# The default target is 30 minutes ago. Needs the reader key of BACKUP_BUCKET
# (the backup key only writes) and the compose profile pitr.
set -eu

target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    *) echo "usage: pitr-drill.sh [--target YYYY-MM-DDTHH:MM:SSZ]" >&2; exit 2 ;;
  esac
done
[ -n "$target" ] || target=$(date -u -d '-30 min' +%Y-%m-%dT%H:%M:%SZ)
: "${AWS_ACCESS_KEY_ID:?reader key of BACKUP_BUCKET}" "${AWS_SECRET_ACCESS_KEY:?reader secret}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

env_value() { sed -n "s/^$1=//p" hosted.env | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
S3_ENDPOINT=$(env_value S3_ENDPOINT)
BACKUP_BUCKET=$(env_value BACKUP_BUCKET)
BACKUP_IMAGE=$(env_value POLKA_BACKUP_IMAGE)
BACKUP_IMAGE=${BACKUP_IMAGE:-polka-backup:local}
compose() { docker compose --env-file hosted.env "$@"; }
PG_IMAGE=$(docker inspect "$(compose ps -q postgres)" --format '{{.Config.Image}}')

name=polka-pitr-drill
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
cleanup
docker volume create "$name" >/dev/null

started=$(date +%s)
docker run --rm --cpus 1 --memory 1g -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
  -e S3_ENDPOINT="$S3_ENDPOINT" -e BACKUP_BUCKET="$BACKUP_BUCKET" \
  -v "$name":/var/lib/postgresql/data --entrypoint polka-pitr-restore "$BACKUP_IMAGE" --target "$target"
docker run -d --name "$name" --network none --cpus 1 --memory 1g -v "$name":/var/lib/postgresql/data "$PG_IMAGE" \
  postgres -c shared_preload_libraries=pg_stat_statements -c shared_buffers=128MB >/dev/null

ready=""
for _ in $(seq 1 150); do
  if docker logs "$name" 2>&1 | grep -q "archive recovery complete"; then
    docker exec "$name" pg_isready -q -U polka_admin && { ready=1; break; }
  fi
  sleep 2
done
docker logs "$name" 2>&1 | grep -E "recovery stopping|archive recovery complete|FATAL|PANIC" || true
[ -n "$ready" ] || { echo "pitr-drill: FAILED — recovery did not complete" >&2; exit 1; }
echo "pitr-drill: restored in $(($(date +%s) - started)) s"

facts="select (select count(*) from revisions)||' '||(select count(*) from artifacts)||' '||(select count(*) from accounts)||' '||(select max(version) from schema_migrations)"
copy=$(docker exec "$name" psql -U polka_admin -d polka -Atc "$facts")
live=$(compose exec -T postgres psql -U polka_admin -d polka -Atc \
  "select (select count(*) from revisions where created_at <= '$target')||' '||(select max(version) from schema_migrations)")
echo "pitr-drill: copy: revisions artifacts accounts schema = $copy"
echo "pitr-drill: live: revisions saved by the target, schema = $live"
# Erased works keep tombstone revision rows; only the cleanup of expired
# provisional shelves deletes revisions. So the copy may hold more revisions
# than the live database saved by the target, never fewer.
copy_revisions=${copy%% *}
live_revisions=${live%% *}
if [ "$copy_revisions" -ge "$live_revisions" ]; then
  echo "pitr-drill: OK, target $target"
else
  echo "pitr-drill: FAILED — $copy_revisions revisions in the copy, fewer than the $live_revisions saved by $target" >&2
  exit 1
fi
