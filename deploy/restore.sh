#!/usr/bin/env bash
#
# Restores the system from an encrypted backup archive.
#
#   ./deploy/restore.sh ~/foundation-backup-2026-08-02T10-15-00.tar.gz
#
# THIS REPLACES THE LIVE DATABASE. It asks for confirmation first.

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { echo -e "${BLUE}==>${NC} $*"; }
ok()   { echo -e "${GREEN} ok${NC} $*"; }
warn() { echo -e "${YELLOW} !!${NC} $*"; }
fail() { echo -e "${RED}ERR${NC} $*" >&2; exit 1; }

ARCHIVE="${1:-}"
[[ -z "$ARCHIVE" ]] && fail "Usage: ./deploy/restore.sh <archive.tar.gz>"
[[ -f "$ARCHIVE" ]] || fail "No such file: $ARCHIVE"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
[[ -f .env ]] || fail ".env not found. Run ./deploy/bootstrap.sh first."

# shellcheck disable=SC1091
set -a; source .env; set +a

: "${POSTGRES_USER:?POSTGRES_USER is not set in .env}"
: "${POSTGRES_DB:?POSTGRES_DB is not set in .env}"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- 1. Unpack --------------------------------------------------------------
info "Unpacking the archive"
mkdir -p "$WORK/extract"
tar -xzf "$ARCHIVE" -C "$WORK/extract" || fail "Could not read that archive. Is it a complete .tar.gz file?"
[[ -f "$WORK/extract/db.dump" ]] || fail "This archive does not contain db.dump - it may be truncated or not a Foundation backup."
ok "unpacked"

# --- 2. Show what is about to be restored -----------------------------------
if [[ -f "$WORK/extract/manifest.json" ]]; then
  echo
  info "Archive contents:"
  cat "$WORK/extract/manifest.json"
  echo
fi

echo
warn "This will REPLACE the current database. Everything in it now will be lost."
read -r -p "Type RESTORE to continue: " CONFIRM
[[ "$CONFIRM" == "RESTORE" ]] || fail "Cancelled."

# --- 3. Safety net ----------------------------------------------------------
info "Taking a safety dump of the current database first"
SAFETY="$REPO_DIR/pre-restore-$(date +%Y%m%d-%H%M%S).dump"
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges > "$SAFETY" \
  || warn "Could not take a safety dump (the database may be empty). Continuing."
[[ -s "$SAFETY" ]] && ok "safety dump written to $SAFETY"

# --- 4. Restore -------------------------------------------------------------
info "Stopping the API so nothing writes during the restore"
docker compose stop api

info "Restoring the database"
docker compose exec -T db pg_restore \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-privileges \
  < "$WORK/extract/db.dump" \
  || warn "pg_restore reported warnings. These are usually harmless 'does not exist' notices from --clean."
ok "database restored"

# --- 5. Uploaded images -----------------------------------------------------
if [[ -d "$WORK/extract/uploads" ]] && [[ -n "$(ls -A "$WORK/extract/uploads" 2>/dev/null)" ]]; then
  # Copied recursively: assets live in subdirectories sharded by hash prefix.
  info "Restoring uploaded images"
  docker compose cp "$WORK/extract/uploads/." api:/app/uploads/ || warn "Could not copy uploads."
  ok "images restored"
else
  info "No uploaded images in this archive"
fi

# --- 6. Back up ------------------------------------------------------------
info "Starting the API"
docker compose start api

info "Waiting for the API to come back"
for i in $(seq 1 40); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ok "API healthy"
    break
  fi
  sleep 3
done

echo
echo "=============================================================="
echo -e "${GREEN}Restore complete.${NC}"
echo
echo "  - Sign in and check that users, tests and results look right."
echo "  - If anything is wrong, the pre-restore state is in:"
echo "      $SAFETY"
echo "    Restore it with:"
echo "      docker compose exec -T db pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --clean --if-exists --no-owner < $SAFETY"
echo "  - LLM API keys only decrypt if ENCRYPTION_KEY in .env is unchanged."
echo "    If it changed, re-enter the keys under Admin > Settings."
echo "=============================================================="
