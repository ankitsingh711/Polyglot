# Multi-stage: compile and build with the full toolchain, ship without it.
#
# The subtlety is better-sqlite3. It is a native module, and there is no prebuilt
# binary for every (node, libc, arch) combination — notably not for linux/arm64,
# which is what Docker Desktop builds by default on an Apple Silicon machine. So
# it compiles from source, and compiling needs python3/make/g++.
#
# Installing production dependencies fresh in the runtime stage therefore fails:
# the toolchain lives in the build stage. Instead the build stage installs
# everything, compiles the module, builds both workspaces, and then prunes its
# own dev dependencies — so the runtime stage copies a node_modules that already
# contains the compiled binary and nothing else.
FROM node:24-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --ignore-scripts=false

COPY . .
RUN npm run build

# Drop dev dependencies but keep the native module that was just compiled.
RUN npm prune --omit=dev && npm cache clean --force

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/server/package.json packages/server/package.json
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY config ./config

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787
# Seeding is idempotent, so a restart never duplicates the demo tenants.
CMD ["sh", "-c", "node packages/server/dist/db/seed.js && node packages/server/dist/index.js"]
