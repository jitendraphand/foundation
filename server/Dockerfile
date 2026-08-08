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

# pg_dump / pg_restore, for the backup feature.
#
# Pinned to the same major version as the database (postgres:16 in
# docker-compose.yml), and taken from the PostgreSQL project's own apt
# repository because Debian bookworm ships only version 15. pg_dump refuses to
# dump a server newer than itself, so the distribution package produces
# "aborting because of server version mismatch" on every backup.
#
# Keep PG_MAJOR in step with the database image if it is ever upgraded. The
# server also picks a matching binary at runtime, so a mismatch degrades to a
# clear error rather than a broken backup.
ARG PG_MAJOR=16
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl gnupg tini \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
    && apt-get purge -y curl gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

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
