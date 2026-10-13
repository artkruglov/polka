FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
WORKDIR /app
COPY package.json package-lock.json ./

# Web bundle only: full dev toolchain, nothing from this stage but dist/ ships.
# dist/ is the same on every platform, so a multi-arch build
# (.github/workflows/release-images.yml) makes it once, natively.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web ./apps/web
COPY packages ./packages
# /privacy and /terms render these texts; they are the only copy.
COPY docs/legal ./docs/legal
# /bookmarklet serves the bookmark built from these (apps/web/vite.config.ts).
COPY extensions ./extensions
RUN npm run build

# Production dependencies only. tsx is the runtime entrypoint; esbuild's
# install script is the one allowed (it validates the platform binary that
# the runtime builder and tsx use).
FROM base AS deps
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm rebuild esbuild \
 && npm cache clean --force

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime

ENV NODE_ENV=production
WORKDIR /app
# Everything is root-owned and read-only for the node user that runs the app.
COPY package.json package-lock.json LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY --from=deps /app/node_modules ./node_modules
COPY apps/server ./apps/server
COPY packages ./packages
# Only server-side operator scripts (.dockerignore drops tests and dev tools).
COPY scripts ./scripts
COPY deploy/migrations ./deploy/migrations
# The single-VM deployment of this very version: deploy/hosted/install.sh
# copies it out of the image (no git checkout on the VM) and runs
# scripts/hosted-setup.mjs here, so the VM needs no Node.js.
COPY deploy/runtime-grants.sql deploy/purge-worker-grants.sql deploy/restore-worker-grants.sql ./deploy/
COPY deploy/hosted ./deploy/hosted
COPY deploy/renderer/seccomp-chromium.json ./deploy/renderer/seccomp-chromium.json
# Operator publication verifies these original sources before registration.
COPY content/editorial ./content/editorial
COPY --from=web /app/dist ./dist
# The runtime builder starts esbuild through this memory-limiting wrapper.
RUN chmod 0755 apps/server/esbuild-limited.sh \
 && node -e "require.resolve('@esbuild/linux-' + (process.arch === 'arm64' ? 'arm64' : 'x64') + '/bin/esbuild')"

USER node
EXPOSE 4390
CMD ["node", "--import", "tsx", "apps/server/main.ts"]
