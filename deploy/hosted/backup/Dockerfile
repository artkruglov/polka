# Backup job image: the same pinned PostgreSQL image as the database (so
# pg_dump matches the server major) plus the AWS CLI, installed once at build
# time instead of on every start.
FROM postgres:16-alpine@sha256:97ff59a4e30e08d1c11bdcd9455e7832368c0572b576c9092cde2df4ae5552a3
RUN apk add --no-cache aws-cli && aws --version
COPY --chmod=0755 backup.sh /usr/local/bin/polka-backup
USER postgres
ENTRYPOINT ["/usr/local/bin/polka-backup"]
