FROM node:26-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212 AS base
WORKDIR /app
COPY package.json package-lock.json ./

# Web bundle only: full dev toolchain, nothing from this stage but dist/ ships.
FROM base AS web
RUN npm ci --no-audit --no-fund
COPY apps/web ./apps/web
COPY packages ./packages
RUN npm run build

# Production dependencies only. tsx is the runtime entrypoint; esbuild's
# install script is the one allowed (it validates the platform binary that
# the runtime builder and tsx use).
FROM base AS deps
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm rebuild esbuild \
 && npm cache clean --force

FROM node:26-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212 AS runtime

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
# Operator publication verifies these original sources before registration.
COPY content/editorial ./content/editorial
COPY --from=web /app/dist ./dist
# The runtime builder starts esbuild through this memory-limiting wrapper.
RUN chmod 0755 apps/server/esbuild-limited.sh \
 && node -e "require.resolve('@esbuild/linux-' + (process.arch === 'arm64' ? 'arm64' : 'x64') + '/bin/esbuild')"

USER node
EXPOSE 4390
CMD ["node", "--import", "tsx", "apps/server/main.ts"]
