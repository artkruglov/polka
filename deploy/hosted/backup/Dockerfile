# Backup job image: the same pinned PostgreSQL image as the database (so
# pg_dump, pg_basebackup and pg_receivewal match the server major) plus the
# AWS CLI, installed once at build time instead of on every start. Three
# jobs (compose.yml): the dumps (backup), the WAL archive (wal-archive) and
# the copy of the works bucket (objects-mirror); polka-pitr-restore prepares
# a restore to a moment in time.
FROM postgres:16-alpine@sha256:97ff59a4e30e08d1c11bdcd9455e7832368c0572b576c9092cde2df4ae5552a3
RUN apk add --no-cache aws-cli && aws --version \
  && install -d -o postgres -g postgres -m 700 /var/lib/polka-wal
COPY --chmod=0755 backup.sh /usr/local/bin/polka-backup
COPY --chmod=0755 wal-archive.sh /usr/local/bin/polka-wal-archive
COPY --chmod=0755 objects-mirror.sh /usr/local/bin/polka-objects-mirror
COPY --chmod=0755 pitr-restore.sh /usr/local/bin/polka-pitr-restore
USER postgres
ENTRYPOINT ["/usr/local/bin/polka-backup"]
