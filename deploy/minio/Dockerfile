# MinIO and its client mc for local development and CI, built from source. MinIO stopped
# publishing community images and binaries (quay.io and Docker Hub answer 401
# for the pinned release, dl.min.io 410), so the same release is compiled here
# from its tagged commit. Development fixture only, not a production object
# store. MinIO is AGPL-3.0: https://github.com/minio/minio
FROM golang:1.24.2-alpine3.21@sha256:7772cb5322baa875edd74705556d08f0eeca7b9c4b5367754ce3f2f00041ccee AS build
ARG MINIO_RELEASE=RELEASE.2025-04-22T22-12-26Z
ARG MINIO_COMMIT=0d7408fc9969caf07de6a8c3a84f9fbb10a6739e
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q . \
 && git fetch -q --depth 1 https://github.com/minio/minio "$MINIO_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$MINIO_COMMIT"
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -tags kqueue \
      -ldflags "-s -w -X github.com/minio/minio/internal/config.Version=$MINIO_RELEASE" \
      -o /minio .
# mc, the client the grants suite runs inside this container (mc admin).
ARG MC_COMMIT=b00526b153a31b36767991a4f5ce2cced435ee8e
WORKDIR /mc
RUN git init -q . \
 && git fetch -q --depth 1 https://github.com/minio/mc "$MC_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$MC_COMMIT"
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /mc-bin .

FROM alpine:3.21@sha256:ce64758a109eb420d874a118f87920e625e12d3634e03b4a5573fd9f6e5d3507
RUN apk add --no-cache curl ca-certificates
COPY --from=build /minio /usr/bin/minio
COPY --from=build /mc-bin /usr/bin/mc
EXPOSE 9000
ENTRYPOINT ["minio"]
