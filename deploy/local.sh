#!/usr/bin/env bash
#
# Start Foundation on this machine for a trial.
#
#   ./deploy/local.sh
#
# Everything the trial needs is either already in the repository or generated
# here. In particular the two secrets are generated rather than pasted in by
# hand: a short or empty JWT_SECRET fails validation, which kills the API
# container on startup, and the only symptom anyone sees is "502" on a sign-in
# page that otherwise looks perfectly healthy. That is a miserable thing to
# debug, and there is no reason a trial should ask for it at all.
#
# Safe to re-run. An existing .env is edited in place, and a secret that is
# already good is never touched - ENCRYPTION_KEY especially, because replacing
# it makes every saved LLM API key unreadable.

set -euo pipefail

cd "$(dirname "$0")/.."

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31m==>\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail \
  "Docker is not installed. On Ubuntu: sudo apt install -y docker.io docker-compose-v2"

docker compose version >/dev/null 2>&1 || fail \
  "The docker compose plugin is missing. On Ubuntu: sudo apt install -y docker-compose-v2"

if ! docker info >/dev/null 2>&1; then
  fail "Cannot talk to the Docker daemon. Either run this with sudo, or add yourself to the docker group:
    sudo usermod -aG docker \$USER   # then log out and back in"
fi

# --- .env ------------------------------------------------------------------

if [ ! -f .env ]; then
  info "Creating .env from .env.example"
  cp .env.example .env
fi

# Values that are missing, empty, still the placeholder, or too short for the
# server's own validation. Anything else is left exactly as it is.
needs_value() {
  local key="$1" min="$2" current
  current=$(sed -n "s|^${key}=||p" .env | head -1)
  [ -z "$current" ] && return 0
  case "$current" in change_me*|"<"*) return 0 ;; esac
  [ "${#current}" -lt "$min" ] && return 0
  return 1
}

# Matches bootstrap.sh: base64 with the characters that are awkward inside an
# env file or a shell removed, then trimmed to a fixed length.
gen() { openssl rand -base64 48 | tr -d '\n/+=' | head -c 48; }

set_value() { sed -i "s|^$1=.*|$1=$2|" .env; }

# Like set_value, but for keys .env.example ships commented out (the n8n
# block): when nothing in .env actually defines the key, append it rather than
# letting a sed against a "# KEY=" line quietly do nothing.
append_value() {
  grep -q "^$1=" .env || echo "$1=$2" >> .env
  set_value "$1" "$2"
}

# Values generated or filled in this run, for the summary at the end. Secrets
# that were already good are not listed - they belong to .env, and repeating
# them would only suggest they are disposable.
GENERATED=()

# JWT_SECRET only signs login sessions, so replacing it costs nothing beyond
# signing everyone out.
if needs_value JWT_SECRET 16; then
  set_value JWT_SECRET "$(gen)"
  GENERATED+=("JWT_SECRET")
else
  info "JWT_SECRET already set, leaving it alone"
fi

# ENCRYPTION_KEY is different: it decrypts the stored LLM API keys, so a new
# one silently orphans them. Replaced only when the current value could not
# work at all, and said out loud when it happens.
if needs_value ENCRYPTION_KEY 16; then
  set_value ENCRYPTION_KEY "$(gen)"
  GENERATED+=("ENCRYPTION_KEY")
  warn "Generated a new ENCRYPTION_KEY - any LLM API keys saved before now must be entered again."
else
  info "ENCRYPTION_KEY already set, leaving it alone"
fi

# ADMIN_PASSWORD is the one a person types, so it is generated too when it is
# still the example value. A laptop trial is usually on a school Wi-Fi with the
# students on it, and "admin / foundation_123" is published in this repository -
# a class finds that in an afternoon. Replacing it here only affects the
# password the seed uses when it creates the administrator; an install that
# already has one keeps whatever was set in the app.
if [ "$(sed -n 's|^ADMIN_PASSWORD=||p' .env | head -1)" = "foundation_123" ]; then
  set_value ADMIN_PASSWORD "$(openssl rand -base64 18 | tr -d '\n/+=' | head -c 16)"
  GENERATED+=("ADMIN_PASSWORD")
else
  info "ADMIN_PASSWORD already set, leaving it alone"
fi

# POSTGRES_PASSWORD is different again, and the placeholder must NOT be
# replaced. Postgres bakes the password into the data volume the first time it
# starts; changing it here afterwards leaves the API unable to log in to its
# own database, which is a worse failure than the weak password. Only a value
# that is actually absent gets filled in.
current_pg=$(sed -n 's|^POSTGRES_PASSWORD=||p' .env | head -1)
if [ -z "$current_pg" ]; then
  set_value POSTGRES_PASSWORD "$(gen)"
  GENERATED+=("POSTGRES_PASSWORD")
else
  info "POSTGRES_PASSWORD already set, leaving it alone"
  case "$current_pg" in
    change_me*)
      warn "POSTGRES_PASSWORD is still the example value. That is acceptable here - the database is not published to the host - but change it before this machine is reachable from anywhere else."
      ;;
  esac
fi

# The trial is served over plain HTTP on this machine, so the hostname is
# localhost and the session cookie cannot be marked Secure.
set_value PUBLIC_HOST localhost
grep -q '^COOKIE_SECURE=' .env || echo 'COOKIE_SECURE=false' >> .env
set_value COOKIE_SECURE false

# n8n ships with the stack now, so its login and encryption key are generated
# here too. The key encrypts stored workflows; like ENCRYPTION_KEY it is only
# ever set when no usable value exists, because replacing it later loses every
# workflow the sidecar has saved.
if needs_value N8N_PASS 12; then
  append_value N8N_PASS "$(openssl rand -base64 18 | tr -d '\n/+=' | head -c 16)"
  GENERATED+=("N8N_PASS (n8n editor login)")
else
  info "N8N_PASS already set, leaving it alone"
fi

# n8n's own default is change_me_n8n_key_32chars_min, so anything shorter than
# 32 characters cannot be the real thing.
if needs_value N8N_ENCRYPTION_KEY 32; then
  append_value N8N_ENCRYPTION_KEY "$(gen)"
  GENERATED+=("N8N_ENCRYPTION_KEY")
else
  info "N8N_ENCRYPTION_KEY already set, leaving it alone"
fi

# --- Up --------------------------------------------------------------------

info "Building and starting (the first build takes a few minutes)"
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build

info "Waiting for the API to come up"
ok=false
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null http://localhost/api/health 2>/dev/null; then ok=true; break; fi
  sleep 2
done

if [ "$ok" != true ]; then
  warn "The API did not answer within two minutes. Its log says why:"
  echo
  docker compose logs api --tail=30
  exit 1
fi

ADMIN_USER=$(sed -n 's|^ADMIN_USERNAME=||p' .env | head -1)
ADMIN_PASS=$(sed -n 's|^ADMIN_PASSWORD=||p' .env | head -1)
N8N_PASS_VALUE=$(sed -n 's|^N8N_PASS=||p' .env | head -1)

echo
info "Foundation is running: http://localhost"
echo
echo "  Sign in (admin):  ${ADMIN_USER:-admin} / ${ADMIN_PASS}"
if [ ${#GENERATED[@]} -gt 0 ]; then
  echo
  echo "  Generated this run:"
  for entry in "${GENERATED[@]}"; do
    key="${entry%% *}"; suffix="${entry#"$key"}"
    value="$(sed -n "s|^${key}=||p" .env | head -1)"
    echo "      $key$suffix: $value"
  done
fi
echo
echo "  n8n editor:       http://n8n.localhost  (login: admin / ${N8N_PASS_VALUE})"
echo
echo "  Everything above also sits in .env on this machine (chmod 600)."
echo "  Change the admin password in the app after your first sign-in."
echo
echo "  Other devices on the same Wi-Fi can join at:"
for ip in $(hostname -I 2>/dev/null); do echo "      http://$ip"; done
echo
echo "  docker compose logs -f api    watch the API"
echo "  docker compose down           stop, keeping all data"
echo "  docker compose down -v        stop and erase everything"
