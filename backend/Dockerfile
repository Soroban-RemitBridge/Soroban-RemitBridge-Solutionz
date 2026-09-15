# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# RemitBridge backend
#
# Debian-slim rather than Alpine: Prisma ships separately-compiled query-engine
# binaries and OpenSSL is a hard requirement, both of which are a recurring
# source of "works locally, fails in the container" on musl images. The size
# difference is not worth that class of bug in a payments service.
# ---------------------------------------------------------------------------

FROM node:22-slim AS base
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- dependencies (cached independently of the source) ----------------------
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json ./
# The Prisma schema is copied before `npm ci` because the client's postinstall
# step reads it; without it the install produces a client with no models.
COPY prisma ./prisma
RUN npm ci

# --- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npm run build

# --- runtime ----------------------------------------------------------------
FROM base AS runtime

# Production dependencies only. `prisma` is a runtime dependency (see
# package.json) precisely so this stage can generate a client and apply
# migrations — an image that cannot migrate itself is an image someone has to
# shell into.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

COPY --from=build /app/dist ./dist

# The entrypoint, copied explicitly. It is NOT part of the build context's
# `.dockerignore`-excluded set, and forgetting it fails at container start rather
# than at build time, which is exactly the kind of gap a smoke test catches and a
# Dockerfile review does not.
COPY docker-migrate.sh ./docker-migrate.sh

# Drop privileges. The process needs no filesystem writes: the database holds
# state, and the container is disposable by design.
USER node

EXPOSE 4000

# `docker-migrate.sh` decides between `migrate deploy` and `db push`; see the
# comment in that file for why it is a decision rather than a fixed command.
ENTRYPOINT ["sh", "./docker-migrate.sh"]
CMD ["node", "dist/index.js"]
