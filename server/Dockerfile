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

# postgresql-client provides pg_dump / pg_restore, used by the backup feature.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates postgresql-client tini \
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
