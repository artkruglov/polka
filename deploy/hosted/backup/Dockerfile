# Backup job image: the same pinned PostgreSQL image as the database (so
# pg_dump matches the server major) plus the AWS CLI, installed once at build
# time instead of on every start.
FROM postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
RUN apk add --no-cache aws-cli && aws --version
COPY --chmod=0755 backup.sh /usr/local/bin/polka-backup
USER postgres
ENTRYPOINT ["/usr/local/bin/polka-backup"]
