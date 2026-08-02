#!/usr/bin/env bash
#
# One-time server setup for Ubuntu 24.04 Minimal (ARM64) on Oracle Cloud.
#
#   ssh ubuntu@YOUR_IP
#   git clone https://github.com/YOUR_USER/foundation.git
#   cd foundation
#   ./deploy/bootstrap.sh
#
# Safe to re-run: every step checks whether it is already done.

set -euo pipefail

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${BLUE}==>${NC} $*"; }
ok()    { echo -e "${GREEN} ok${NC} $*"; }
warn()  { echo -e "${YELLOW} !!${NC} $*"; }
fail()  { echo -e "${RED}ERR${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] && fail "Run this as the 'ubuntu' user, not as root. sudo is used where needed."

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

info "Architecture: $(uname -m)   Ubuntu: $(lsb_release -rs 2>/dev/null || echo unknown)"

# --- 1. Base packages -------------------------------------------------------
# Ubuntu Minimal ships without curl, git or ca-certificates.
info "Installing base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl git gnupg openssl ufw ncurses-bin
ok "base packages"

# --- 2. Docker --------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  ok "docker already installed ($(docker --version))"
else
  info "Installing Docker Engine (arm64)"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER"
  ok "docker installed"
  warn "You were added to the 'docker' group. Log out and back in, then re-run this script."
  warn "Or continue right now in this session with:  exec sg docker -- ./deploy/bootstrap.sh"
  exit 0
fi

docker info >/dev/null 2>&1 || fail "Cannot talk to the Docker daemon. Log out and back in so your 'docker' group membership takes effect."

# --- 3. Swap ----------------------------------------------------------------
# 12 GB of RAM is plenty for running the stack, but the first `docker compose
# build` compiles TypeScript in two containers at once. A small swap file makes
# that reliable and costs nothing at runtime.
if [[ -f /swapfile ]]; then
  ok "swap already configured"
else
  info "Creating a 2 GB swap file"
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  ok "swap enabled"
fi

# --- 4. Host firewall -------------------------------------------------------
# Oracle images ship with iptables rules that block everything except SSH, and
# they survive reboots. Ports 80 and 443 must be opened here AND in the Oracle
# Cloud console security list - both layers matter.
info "Opening ports 80 and 443 on the host firewall"
sudo iptables -I INPUT 5 -m state --state NEW -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT 5 -m state --state NEW -p tcp --dport 443 -j ACCEPT 2>/dev/null || true

if command -v netfilter-persistent >/dev/null 2>&1; then
  sudo netfilter-persistent save >/dev/null 2>&1 || true
  ok "iptables rules saved"
else
  sudo apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
  sudo netfilter-persistent save >/dev/null 2>&1 || true
  ok "iptables rules saved"
fi

# --- 5. .env ----------------------------------------------------------------
if [[ -f .env ]]; then
  ok ".env already exists, leaving it alone"
else
  info "Creating .env with freshly generated secrets"
  cp .env.example .env

  gen() { openssl rand -base64 48 | tr -d '\n/+=' | head -c 48; }

  DB_PASS="$(gen)"; JWT="$(gen)"; ENC="$(gen)"; BACKUP="$(gen)"

  # Detect the public IP so PUBLIC_HOST can be pre-filled with a working
  # sslip.io hostname. Oracle's metadata service is authoritative; ifconfig.me
  # is the fallback.
  PUBLIC_IP="$(curl -s --max-time 5 -H 'Authorization: Bearer Oracle' \
      http://169.254.169.254/opc/v2/vnics/ 2>/dev/null \
      | grep -o '"publicIp"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  [[ -z "$PUBLIC_IP" ]] && PUBLIC_IP="$(curl -s --max-time 5 https://ifconfig.me 2>/dev/null || true)"

  if [[ -n "$PUBLIC_IP" ]]; then
    SSLIP_HOST="${PUBLIC_IP//./-}.sslip.io"
    sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=${SSLIP_HOST}|" .env
    ok "detected public IP ${PUBLIC_IP}, PUBLIC_HOST set to ${SSLIP_HOST}"
  else
    warn "Could not detect the public IP. Edit PUBLIC_HOST in .env by hand."
  fi

  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${DB_PASS}|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT}|" .env
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${ENC}|" .env
  sed -i "s|^BACKUP_PASSPHRASE=.*|BACKUP_PASSPHRASE=${BACKUP}|" .env
  chmod 600 .env
  ok ".env created"

  echo
  warn "WRITE THIS DOWN AND KEEP IT SOMEWHERE SAFE, NOT ONLY ON THIS SERVER:"
  echo "    BACKUP_PASSPHRASE=${BACKUP}"
  warn "Without it, your backup archives cannot be restored."
  echo
fi

# --- 6. Build and start -----------------------------------------------------
info "Building images - the first build takes 5-10 minutes on 2 OCPUs"
docker compose build

info "Starting the stack"
docker compose up -d

info "Waiting for the API to become healthy"
for i in $(seq 1 60); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ok "API is healthy"
    break
  fi
  [[ $i -eq 60 ]] && { warn "API did not become healthy in time. Check: docker compose logs api"; }
  sleep 3
done

# --- Done -------------------------------------------------------------------
PUBLIC_HOST_VALUE="$(grep '^PUBLIC_HOST=' .env | cut -d= -f2)"

echo
echo "=============================================================="
echo -e "${GREEN}Foundation is up.${NC}"
echo
echo "  URL:      https://${PUBLIC_HOST_VALUE}"
echo "  Admin:    $(grep '^ADMIN_USERNAME=' .env | cut -d= -f2)"
echo "  Password: $(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2)"
echo
echo "Next steps:"
echo "  1. Open Oracle Cloud console > Networking > VCN > Security List and"
echo "     allow ingress TCP on ports 80 and 443 from 0.0.0.0/0."
echo "     (See deploy/DEPLOYMENT.md, section 4, for the exact clicks.)"
echo "  2. Visit the URL above. The first load takes ~15 seconds while Caddy"
echo "     obtains its HTTPS certificate."
echo "  3. Sign in and change the admin password immediately."
echo "  4. Add an LLM API key under Admin > Settings."
echo "  5. Set docs/config.js SERVER_URL to https://${PUBLIC_HOST_VALUE}"
echo "     and enable GitHub Pages so the Enter button works."
echo "=============================================================="
