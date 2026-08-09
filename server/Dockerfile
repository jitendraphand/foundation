# Multi-stage build. node:22-bookworm-slim has native linux/arm64 images, so
# this builds and runs natively on the Ampere A1 (aarch64) shape.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# openssl is required by Prisma's query engine at generate time.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runtime essentials, from Debian's own repository so this layer cannot fail
# for a reason outside the machine.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# pg_dump / pg_restore, for the backup feature.
#
# Debian bookworm ships PostgreSQL client 15, and pg_dump refuses to dump a
# server newer than itself - so against the postgres:16 database every backup
# fails with "aborting because of server version mismatch". The matching client
# comes from the PostgreSQL project's own apt repository.
#
# That repository is a third party, and reaching it is the one part of this
# build that depends on a host nobody here controls. So it is attempted, not
# required: if the key or the repo cannot be fetched, the build falls back to
# Debian's client and carries on. The server picks a matching binary at runtime
# and, finding none, fails the backup with a message naming the package to
# install. A degraded backup is a far better outcome than an image that will
# not build, which takes the whole system down with it.
#
# Keep PG_MAJOR in step with the database image if it is ever upgraded.
ARG PG_MAJOR=16
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl gnupg; \
    if curl -fsS --max-time 30 -o /tmp/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       && gpg --dearmor -o /usr/share/keyrings/pgdg.gpg /tmp/pgdg.asc; then \
      echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list; \
      apt-get update || { echo "[build] PGDG unreachable, using Debian's client"; rm -f /etc/apt/sources.list.d/pgdg.list; apt-get update; }; \
    else \
      echo "[build] could not fetch the PGDG signing key, using Debian's client"; \
    fi; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
      || apt-get install -y --no-install-recommends postgresql-client; \
    pg_dump --version; \
    apt-get purge -y curl gnupg; \
    rm -rf /var/lib/apt/lists/* /tmp/pgdg.asc

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh \
    && mkdir -p /app/uploads /app/backups \
    && chown -R node:node /app/uploads /app/backups

USER node
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
