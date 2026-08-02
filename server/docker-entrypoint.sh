#!/bin/sh
#
# Runs on every container start: wait for the database, apply any pending
# migrations, seed the baseline vocabulary, then hand over to the API.
# Every step is idempotent, so a restart or an upgrade is safe.

set -e

: "${PGHOST:=db}"
: "${PGUSER:=foundation}"
: "${PGDATABASE:=foundation}"

echo "[entrypoint] waiting for postgres at ${PGHOST}..."
i=0
until pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -q; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[entrypoint] postgres did not become ready within 120s" >&2
    exit 1
  fi
  sleep 2
done
echo "[entrypoint] postgres is ready"

echo "[entrypoint] applying migrations..."
npx prisma migrate deploy

echo "[entrypoint] seeding baseline data (idempotent)..."
node dist/seed.js

echo "[entrypoint] starting api..."
exec "$@"
