# Multi-stage: build with dev dependencies, ship without them.
FROM node:24-slim AS build
WORKDIR /app

# python3/make/g++ are here only in case better-sqlite3 has no prebuild for the
# target platform; they never reach the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --ignore-scripts=false

COPY . .
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --workspace @polyglot/server --ignore-scripts=false \
    && npm cache clean --force

COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY config ./config

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787
# Seeding is idempotent, so a restart never duplicates the demo tenants.
CMD ["sh", "-c", "node packages/server/dist/db/seed.js && node packages/server/dist/index.js"]
