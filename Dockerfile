FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/deploy/migrations ./deploy/migrations
COPY --from=build --chown=node:node /app/dist ./dist
# Operator publication verifies these original sources before registration.
COPY --from=build --chown=node:node /app/content/editorial ./content/editorial
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE

USER node
EXPOSE 4390
CMD ["node", "--import", "tsx", "apps/server/main.ts"]
