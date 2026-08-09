#!/bin/sh
#
# Runs on every container start: wait for the database, apply any pending
# migrations, seed the baseline vocabulary, then hand over to the API.
# Every step is idempotent, so a restart or an upgrade is safe.
#
# Every failure here ends the container, and because Caddy sits in front, the
# only thing the operator sees is "502" on a sign-in page that otherwise looks
# fine. So each step explains itself on the way out: the log is the only place
# the real reason can appear, and "exit 1" is not a reason.

set -e

: "${PGHOST:=db}"
: "${PGUSER:=foundation}"
: "${PGDATABASE:=foundation}"

fatal() {
  echo >&2
  echo "=====================================================================" >&2
  echo " Foundation could not start." >&2
  echo "=====================================================================" >&2
  echo >&2
  printf '%s\n' "$@" >&2
  echo >&2
  echo " The API container will keep restarting until this is fixed, and the" >&2
  echo " site will answer 502 in the meantime." >&2
  echo "=====================================================================" >&2
  exit 1
}

echo "[entrypoint] waiting for postgres at ${PGHOST}..."
i=0
until pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -q; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    fatal " The database never became ready (waited 120s)." \
          "" \
          " Check it is running and healthy:" \
          "     docker compose ps" \
          "     docker compose logs db" \
          "" \
          " If the db container is restarting, POSTGRES_PASSWORD in .env may" \
          " have been changed after the database was first created - the old" \
          " password is baked into the volume."
  fi
  sleep 2
done
echo "[entrypoint] postgres is ready"

echo "[entrypoint] applying migrations..."
if ! migrate_out=$(npx prisma migrate deploy 2>&1); then
  echo "$migrate_out" >&2
  case "$migrate_out" in
    *P3005*)
      fatal " The database already has tables, but no record of which" \
            " migrations created them. Prisma will not guess." \
            "" \
            " This happens when the database was first created by an older" \
            " build. Tell Prisma the existing schema is already applied:" \
            "" \
            "     docker compose run --rm api npx prisma migrate resolve \\" \
            "         --applied 20260802000000_init" \
            "" \
            " then start again. If the data does not matter, this wipes it" \
            " and starts clean instead:" \
            "" \
            "     docker compose down -v && docker compose up -d --build"
      ;;
    *already\ exists*|*42P07*)
      fatal " A migration tried to create something that is already there," \
            " which means the database and the migration history disagree." \
            "" \
            " See the Prisma output above for which one. If the data does" \
            " not matter yet:" \
            "" \
            "     docker compose down -v && docker compose up -d --build"
      ;;
    *)
      fatal " Applying database migrations failed. The Prisma output above" \
            " says why."
      ;;
  esac
fi
echo "$migrate_out"

echo "[entrypoint] seeding baseline data (idempotent)..."
if ! seed_out=$(node dist/seed.js 2>&1); then
  echo "$seed_out" >&2
  case "$seed_out" in
    *"invalid configuration"*)
      fatal " The configuration in .env is not valid - the exact field is" \
            " named above." \
            "" \
            " JWT_SECRET and ENCRYPTION_KEY must each be at least 16" \
            " characters. Generate real ones with:" \
            "" \
            "     openssl rand -base64 48" \
            "" \
            " Then put them in .env and run docker compose up -d again." \
            "" \
            " Note that changing ENCRYPTION_KEY makes previously saved LLM" \
            " API keys unreadable; they have to be entered again."
      ;;
    *)
      fatal " Seeding the baseline data failed. The output above says why."
      ;;
  esac
fi
echo "$seed_out"

echo "[entrypoint] starting api..."
exec "$@"
