#!/usr/bin/env bash
#
# Development deployment: hot-reload API and frontend against a local
# PostgreSQL, with every secret generated rather than pasted from the README.
#
#   ./deploy/dev.sh
#
# What it does:
#   1. Generates the dev secrets into .env.dev on first run (git-ignored,
#      chmod 600) and reuses them afterwards.
#   2. Starts (or reuses) the foundation-db PostgreSQL container with that
#      password.
#   3. Installs dependencies if needed, applies migrations, builds, and seeds
#      once - only when the database has no users yet.
#   4. Starts the API (:4000) and Vite (:5173) with hot reload, waits for both
#      to answer, then prints everything you need: URLs, admin login, secrets,
#      log files. Ctrl-C stops both servers; data survives in the container.
#
# Safe to re-run: existing secrets, an existing database and its volume are
# never touched.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31m==>\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail \
  "Docker is not installed. On Ubuntu: sudo apt install -y docker.io docker-compose-v2"

docker info >/dev/null 2>&1 || fail \
  "Cannot talk to the Docker daemon. Either run this with sudo, or add yourself to the docker group:
    sudo usermod -aG docker \$USER   # then log out and back in"

command -v curl >/dev/null 2>&1 || fail "curl is required to wait for the servers."

# Matches local.sh and bootstrap.sh: base64 with awkward characters removed.
gen() { openssl rand -base64 48 | tr -d '\n/+=' | head -c 48; }

ENV_FILE="$REPO_DIR/.env.dev"

# --- Secrets ----------------------------------------------------------------

if [ ! -f "$ENV_FILE" ]; then
  info "Generating development secrets into .env.dev"
  {
    echo "POSTGRES_PASSWORD=$(gen)"
    echo "JWT_SECRET=$(gen)"
    echo "ENCRYPTION_KEY=$(gen)"
    # Short enough to read off a terminal and type once; changed in the app.
    echo "ADMIN_USERNAME=admin"
    echo "ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '\n/+=' | head -c 16)"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  info "Using existing .env.dev"
fi

# Fill any key that is missing or empty without disturbing the others.
ensure() {
  local key="$1" value="$2" current
  current="$(sed -n "s|^${key}=||p" "$ENV_FILE" | head -1)"
  [ -z "$current" ] || return 0
  echo "$key=$value" >> "$ENV_FILE"
}

for key in POSTGRES_PASSWORD JWT_SECRET ADMIN_USERNAME ADMIN_PASSWORD; do
  grep -q "^${key}=..*" "$ENV_FILE" || ensure "$key" "$(gen)"
done
grep -q '^ADMIN_USERNAME=..*' "$ENV_FILE" || ensure ADMIN_USERNAME admin

get() { sed -n "s|^$1=||p" "$ENV_FILE" | head -1; }

DB_PASS="$(get POSTGRES_PASSWORD)"
JWT_SECRET="$(get JWT_SECRET)"
ENCRYPTION_KEY="$(get ENCRYPTION_KEY)"
ADMIN_USER="$(get ADMIN_USERNAME)"
ADMIN_PASSWORD="$(get ADMIN_PASSWORD)"

if [ "${#JWT_SECRET}" -lt 16 ] || [ "${#ENCRYPTION_KEY}" -lt 16 ]; then
  fail "JWT_SECRET or ENCRYPTION_KEY in $ENV_FILE is shorter than 16 characters. Delete the line and re-run."
fi

# --- Database ---------------------------------------------------------------

DB_CONTAINER=foundation-db
DB_PORT="${FOUNDATION_DB_PORT:-5432}"

if docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  info "PostgreSQL container '$DB_CONTAINER' already running"
elif docker ps -a --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  info "Starting existing PostgreSQL container '$DB_CONTAINER'"
  docker start "$DB_CONTAINER" >/dev/null
else
  if docker ps --format '{{.Ports}} {{.Names}}' | grep -q ":$DB_PORT->" ; then
    fail "Port $DB_PORT is already used by another container. Set FOUNDATION_DB_PORT to a free port and re-run."
  fi
  info "Creating PostgreSQL container '$DB_CONTAINER'"
  docker run -d --name "$DB_CONTAINER" -p "$DB_PORT":5432 \
    -e POSTGRES_PASSWORD="$DB_PASS" -e POSTGRES_USER=foundation -e POSTGRES_DB=foundation \
    postgres:16-alpine >/dev/null
fi

info "Waiting for PostgreSQL to accept connections"
db_ready=false
for _ in $(seq 1 30); do
  if docker exec "$DB_CONTAINER" pg_isready -U foundation -d foundation >/dev/null 2>&1; then
    db_ready=true
    break
  fi
  sleep 1
done
$db_ready || fail "PostgreSQL did not become ready. Check: docker logs $DB_CONTAINER"

export DATABASE_URL="postgresql://foundation:${DB_PASS}@localhost:${DB_PORT}/foundation?schema=public"
export JWT_SECRET ENCRYPTION_KEY
# The seed creates the first administrator from these two; without them it
# would quietly fall back to its own defaults and the printed login would not
# work.
export ADMIN_USERNAME="$ADMIN_USER" ADMIN_PASSWORD="$ADMIN_PASSWORD"
export UPLOAD_DIR="$REPO_DIR/server/uploads" BACKUP_DIR="$REPO_DIR/server/backups"
export NODE_ENV=development
mkdir -p "$UPLOAD_DIR" "$BACKUP_DIR"

# --- Dependencies, migrations, seed -----------------------------------------

info "Installing server dependencies (skipped when present)"
[ -d server/node_modules ] || (cd server && npm install --no-fund --no-audit)

info "Installing web dependencies (skipped when present)"
[ -d web/node_modules ] || (cd web && npm install --no-fund --no-audit)

info "Applying database migrations"
(cd server && npx prisma migrate deploy)

info "Building the server (needed once for the seed script)"
(cd server && npx tsc)

USER_COUNT=$(docker exec "$DB_CONTAINER" psql -U foundation -d foundation -tAc 'SELECT COUNT(*) FROM "User"' 2>/dev/null || echo 0)
if [ "${USER_COUNT:-0}" = "0" ]; then
  info "Seeding the database (first run only)"
  (cd server && node dist/seed.js)
else
  info "Database already has ${USER_COUNT} users, skipping seed"
fi

# --- Servers ----------------------------------------------------------------

API_LOG=/tmp/foundation-dev-api.log
WEB_LOG=/tmp/foundation-dev-web.log

# setsid gives each server its own process group, so cleanup can take down the
# whole tree - npm spawns a shell, which spawns node, which spawns esbuild -
# rather than orphaning whatever survived the first kill.
start_server() { # $1 = directory under the repo, $2 = log file
  setsid bash -c "cd '$REPO_DIR/$1' && npm run dev" >"$2" 2>&1 &
}

cleanup() {
  local pid
  for pid in "${API_PID:-}" "${WEB_PID:-}"; do
    [ -n "$pid" ] || continue
    kill -- "-$pid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

info "Starting the API on :4000 (hot reload, log: $API_LOG)"
start_server server "$API_LOG"
API_PID=$!

info "Starting the frontend on :5173 (hot reload, log: $WEB_LOG)"
start_server web "$WEB_LOG"
WEB_PID=$!

wait_for() {
  local url="$1" name="$2" pid="$3" log="$4" i
  for i in $(seq 1 60); do
    kill -0 "$pid" >/dev/null 2>&1 || { warn "$name died - last lines:"; tail -20 "$log"; return 1; }
    curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    sleep 2
  done
  warn "$name did not answer within two minutes - last lines:"
  tail -20 "$log"
  return 1
}

API_OK=false; WEB_OK=false
wait_for "http://localhost:4000/api/health" "API" "$API_PID" "$API_LOG" && API_OK=true || true
wait_for "http://localhost:5173/" "Frontend" "$WEB_PID" "$WEB_LOG" && WEB_OK=true || true

echo
echo "=============================================================="
if [ "$API_OK" = true ] && [ "$WEB_OK" = true ]; then
  printf '\033[0;32mDevelopment environment is up.\033[0m\n'
else
  warn "Development environment started with problems (see above)."
fi
echo
echo "  Frontend:  http://localhost:5173   (proxies /api to :4000)"
echo "  API:       http://localhost:4000/api/health"
echo
echo "  Admin login: ${ADMIN_USER} / ${ADMIN_PASSWORD}"
echo
echo "  Generated development secrets (.env.dev, chmod 600):"
echo "      POSTGRES_PASSWORD  ${DB_PASS}"
echo "      DATABASE_URL       ${DATABASE_URL}"
echo "      JWT_SECRET         ${JWT_SECRET}"
echo "      ENCRYPTION_KEY     ${ENCRYPTION_KEY}"
echo
echo "  Logs:   $API_LOG / $WEB_LOG"
echo "  Stop:   Ctrl-C (servers stop; the database keeps its data)"
echo "          docker rm -f $DB_CONTAINER   removes the database too"
echo "=============================================================="

# Stay in the foreground while the two servers run, so Ctrl-C reaches them.
wait "$API_PID" 2>/dev/null || true
