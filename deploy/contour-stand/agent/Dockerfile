# The sandbox image for third-party agents on the contour stand. It holds the
# agent and the tools a bugfix needs, and no credentials: the model key and
# the Полка token come with the task, the git token is added by the proxy.
FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34
ARG CODEX_VERSION=0.162.1
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git python3 curl ca-certificates ripgrep >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --silent "@openai/codex@${CODEX_VERSION}"
COPY codex.toml /opt/contour/codex.toml
COPY probe.sh entry.sh /opt/contour/
RUN chmod 755 /opt/contour/*.sh
USER node
WORKDIR /work
ENTRYPOINT ["/opt/contour/entry.sh"]
