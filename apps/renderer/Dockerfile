# Полка's headless renderer (docs/specs/URL_IMPORT_SUPPORT.md, «Рендерер»).
# Built from the repository root:
#   docker build -f apps/renderer/Dockerfile -t polka-renderer:local .
# The official Playwright image, pinned by digest (v1.63.0-noble, multi-arch):
# Chromium 1243 matching playwright-core 1.63.0 in package.json, Node 24 which
# runs these TypeScript files directly (type stripping, no build step).
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    RENDERER_HOST=0.0.0.0 \
    RENDERER_PORT=4395 \
    EGRESS_PORT=3128
WORKDIR /renderer
COPY apps/renderer/package.json apps/renderer/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Only what the renderer runs: no app code, no database or storage clients.
COPY packages/public-address.ts packages/renderer-contract.ts packages/robots.ts packages/
COPY packages/contracts/link-providers.ts packages/contracts/
COPY apps/renderer/challenge.ts apps/renderer/egress-proxy.ts apps/renderer/fetch-page.ts apps/renderer/proxied-fetch.ts apps/renderer/render.ts apps/renderer/server.ts apps/renderer/snapshot.ts apps/renderer/

# The image's unprivileged user; compose adds read_only, cap_drop ALL and limits.
USER pwuser
EXPOSE 4395
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4395/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/renderer/server.ts"]
