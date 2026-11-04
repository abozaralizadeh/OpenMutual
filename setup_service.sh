#!/usr/bin/env bash
# Sets up or updates the OpenMutual simulation on a Linux VM (Ubuntu or Debian).
# Run it again any time: it updates, rebuilds and restarts. Add --fresh to start over with a new chain.
#
# Two ways to run it.
#
# 1. A VM of its own (standalone):
#      sudo bash setup_service.sh
#    Installs Node 24 with apt if it's missing. The web app listens on WEB_PORT (3417) and you
#    open it at http://<vm>:3417. Services: openmutual-chain, openmutual-worker, openmutual-web.
#
# 2. A shared VM that already runs nginx (NGINX_SNIPPET switches this on):
#      sudo SERVICE_NAME=idea-openmutual PORT=8605 BASE_PATH=/openmutual/ \
#           NGINX_SNIPPET=/etc/nginx/max.d/openmutual.conf ./setup_service.sh
#    No apt, no firewall, no certificates, and nothing in sites-available or sites-enabled.
#    Node 24, nginx and curl must be there already, or it stops and says what's missing.
#    Everything binds 127.0.0.1. PORT is the one way in, through nginx at BASE_PATH.
#    The chain takes a free port from 8650 to 8659. Services: $SERVICE_NAME (the web app),
#    $SERVICE_NAME-chain and $SERVICE_NAME-worker.
#    It writes two nginx files only: NGINX_SNIPPET (the location blocks) and
#    /etc/nginx/conf.d/$SERVICE_NAME-limits.conf (the rate limit zone). It runs nginx -t and
#    reloads. If the check fails, both files go back to how they were. The server block that
#    serves the site must include the snippet's folder.
#
# Logs:
#   journalctl -u openmutual-web -f        (standalone; also -worker and -chain)
#   journalctl -u idea-openmutual -f       (shared, the web app; 'idea-openmutual*' shows all three)
#   Size-limited copies (15 MB each at most) in $APP_DIR/logs, easy to copy back for debugging:
#   scp -r user@vm:/path/to/OpenMutual/logs ./vm-logs
#
# It keeps an existing .env and only changes the keys this run sets (ports, path, host).
# Test money on a local chain only. The chain listens on 127.0.0.1 and is never reachable
# from outside. Nothing here touches a public network.
set -euo pipefail

die() { printf '\nStopped: %s\n' "$1" >&2; exit 1; }
say() { printf '\n== %s\n' "$1"; }

[ "$(id -u)" -eq 0 ] || die "run it with sudo: sudo bash setup_service.sh"

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"
ENV_FILE="$APP_DIR/.env"
NODE_MAJOR=24
FRESH=0
[ "${1:-}" = "--fresh" ] && FRESH=1
SHARED=0
[ -n "${NGINX_SNIPPET:-}" ] && SHARED=1

if [ "$SHARED" = "1" ]; then SERVICE="${SERVICE_NAME:-openmutual}"; else SERVICE="${SERVICE_NAME:-}"; fi
if [ -n "$SERVICE" ]; then
  [[ "$SERVICE" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "SERVICE_NAME can only have lowercase letters, digits and dashes"
  WEB_UNIT="$SERVICE"
  CHAIN_UNIT="$SERVICE-chain"
  WORKER_UNIT="$SERVICE-worker"
else
  WEB_UNIT=openmutual-web
  CHAIN_UNIT=openmutual-chain
  WORKER_UNIT=openmutual-worker
fi
UNITS=("$CHAIN_UNIT" "$WORKER_UNIT" "$WEB_UNIT")

as_app() { sudo -u "$APP_USER" -H env PATH="$PATH" bash -c "cd '$APP_DIR' && $1"; }
node_major() { node -p 'process.versions.node.split(".")[0]'; }
port_busy() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }

if [ "$SHARED" = "1" ]; then
  say "Checking what's already on this VM (shared mode, nothing gets installed)"
  missing=()
  for tool in node npm nginx curl systemctl ss sudo; do command -v "$tool" >/dev/null || missing+=("$tool"); done
  [ ${#missing[@]} -eq 0 ] || die "missing on this VM: ${missing[*]}. Shared mode installs nothing, so add them first."
  [ "$(node_major)" -ge "$NODE_MAJOR" ] || die "Node $NODE_MAJOR or newer is needed, this VM has $(node --version)."
  grep -qE 'include\s+/etc/nginx/conf\.d/\*\.conf' /etc/nginx/nginx.conf \
    || die "nginx.conf doesn't include /etc/nginx/conf.d/*.conf, so the rate limit zone can't go in. Nothing changed."
  [[ "$NGINX_SNIPPET" == /etc/nginx/*.conf ]] || die "NGINX_SNIPPET must be a .conf file under /etc/nginx, like /etc/nginx/max.d/openmutual.conf"
  [[ "$NGINX_SNIPPET" == */sites-available/* || "$NGINX_SNIPPET" == */sites-enabled/* ]] && die "NGINX_SNIPPET can't go in sites-available or sites-enabled"
  [ -d "$(dirname "$NGINX_SNIPPET")" ] || die "$(dirname "$NGINX_SNIPPET") doesn't exist. Make it and include it from the server block first."
  BASE="${BASE_PATH:-/openmutual/}"
  [[ "$BASE" =~ ^(/[A-Za-z0-9._-]+)+/$ ]] || die "BASE_PATH must start and end with a slash, like /openmutual/"
  [ -n "${PORT:-}" ] || die "set PORT, the one port nginx sends traffic to, like PORT=8605"
  echo "Node $(node --version), $(nginx -v 2>&1), all there."
else
  say "System packages"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg
  if ! command -v node >/dev/null || [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
    say "Node.js $NODE_MAJOR"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y -qq nodejs
  fi
  node --version
  BASE="${BASE_PATH:-}"
  [ -z "$BASE" ] || [[ "$BASE" =~ ^(/[A-Za-z0-9._-]+)+/$ ]] || die "BASE_PATH must start and end with a slash, like /openmutual/"
fi
[ -z "${PORT:-}" ] || [[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT must be a number"
NODE_DIR="$(dirname "$(command -v node)")"

say "Stopping services"
systemctl stop "${UNITS[@]}" 2>/dev/null || true
# Other units that run this same folder (from the other mode, or another SERVICE_NAME) would
# share its chain and data, so they're switched off. Their files stay.
for file in /etc/systemd/system/*.service; do
  [ -f "$file" ] || continue
  unit="$(basename "$file" .service)"
  [[ " ${UNITS[*]} " == *" $unit "* ]] && continue
  if grep -qxF "WorkingDirectory=$APP_DIR" "$file"; then
    echo "Switching off $unit, it runs this same folder."
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
  fi
done

say "Settings"
get_env() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
set_env() {
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  set_env ADMIN_TOKEN "$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"
  # On a VM other people can reach, the clock is the admin's by default.
  set_env PUBLIC_CLOCK false
  echo "Made .env with a new admin token. Read it with: sudo grep ADMIN_TOKEN $ENV_FILE"
else
  echo "Keeping the existing .env."
fi
[ -n "${PORT:-}" ] && set_env WEB_PORT "$PORT"
[ -n "$BASE" ] && set_env BASE_PATH "$BASE"
if [ "$SHARED" = "1" ]; then
  set_env WEB_HOST 127.0.0.1
  set_env TRUST_PROXY 127.0.0.1
  port_busy "$PORT" && die "port $PORT is already taken by something else. Pick another PORT."
  # The chain gets the first free port from 8650 to 8659, or CHAIN_PORT if you set one.
  CHAIN="${CHAIN_PORT:-$(get_env CHAIN_PORT)}"
  if [ -z "$CHAIN" ] || port_busy "$CHAIN"; then
    [ -n "${CHAIN_PORT:-}" ] && die "CHAIN_PORT $CHAIN_PORT is already taken"
    CHAIN=""
    for candidate in $(seq 8650 8659); do port_busy "$candidate" || { CHAIN="$candidate"; break; }; done
    [ -n "$CHAIN" ] || die "ports 8650 to 8659 are all taken, so the chain has nowhere to go. Set CHAIN_PORT."
  fi
  set_env CHAIN_PORT "$CHAIN"
  set_env RPC_URL "http://127.0.0.1:$CHAIN"
fi
chown "$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
chown "$APP_USER" "$APP_DIR/data" "$APP_DIR/logs"
WEB_PORT_NOW="$(get_env WEB_PORT)"
RPC_NOW="$(get_env RPC_URL)"
# The path the app is built under, from this run or an earlier one.
BASE_NOW="$(get_env BASE_PATH)"
[ -n "$BASE_NOW" ] && BASE_NOW="${BASE_NOW%/}/"
echo "Web on port ${WEB_PORT_NOW:-3417}${BASE_NOW:+ under $BASE_NOW}, chain at ${RPC_NOW:-http://127.0.0.1:8545}"

say "Install and build"
as_app "npm ci --no-audit --no-fund"
as_app "bash scripts/forge.sh build --quiet"
as_app "npm run gen -w shared --silent"
# The base path is baked into the web build, so the build reads .env too.
as_app "set -a; . ./.env; set +a; npm run build -w web --silent"

say "Services"
write_unit() { # name, description, after, restart, command
  local requires=""
  [ -n "$3" ] && requires="After=$3
Requires=$3"
  [ -z "$3" ] && requires="After=network.target"
  cat > "/etc/systemd/system/$1.service" <<UNIT
[Unit]
Description=$2
$requires

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
Environment=PATH=$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$5
Restart=$4
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT
}
write_unit "$CHAIN_UNIT" "OpenMutual local test chain (127.0.0.1 only)" "" on-failure "/usr/bin/env bash scripts/chain.sh"
write_unit "$WORKER_UNIT" "OpenMutual worker (results, settling, claims)" "$CHAIN_UNIT.service" always "/usr/bin/env npm run start -w worker --silent"
write_unit "$WEB_UNIT" "OpenMutual web app" "$CHAIN_UNIT.service" always "/usr/bin/env npm run start -w web --silent"
systemctl daemon-reload
systemctl enable "${UNITS[@]}" >/dev/null

say "Chain"
if [ "$FRESH" = "1" ]; then
  rm -f "$APP_DIR/data/chain-state.json" "$APP_DIR/data/deployment.json"
fi
systemctl start "$CHAIN_UNIT"
CHAIN_UP=0
for _ in $(seq 1 100); do
  if curl -s -o /dev/null -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "${RPC_NOW:-http://127.0.0.1:8545}"; then CHAIN_UP=1; break; fi
  sleep 0.2
done
[ "$CHAIN_UP" = "1" ] || die "the chain didn't start. Look at: journalctl -u $CHAIN_UNIT -n 50"

if [ ! -f "$APP_DIR/data/deployment.json" ]; then
  say "First deployment"
  as_app "set -a; . ./.env; set +a; npm run deploy -w shared --silent"
else
  echo "Keeping the existing chain and data. Use --fresh to start over."
fi

say "Starting"
systemctl restart "$WORKER_UNIT" "$WEB_UNIT"
HOME_URL="http://127.0.0.1:${WEB_PORT_NOW:-3417}${BASE_NOW:-/}"
WEB_UP=0
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$HOME_URL")" = "200" ] && { WEB_UP=1; break; }
  sleep 1
done
systemctl --no-pager --lines=0 status "${UNITS[@]}" | grep -E '●|Active:' || true
[ "$WEB_UP" = "1" ] || die "the web app didn't answer at $HOME_URL. Look at: journalctl -u $WEB_UNIT -n 50"
echo "The web app answers at $HOME_URL"

if [ "$SHARED" = "1" ]; then
  say "nginx"
  ZONE="${SERVICE//-/_}"
  ZONE_FILE="/etc/nginx/conf.d/${SERVICE}-limits.conf"
  BACKUP="$(mktemp -d)"
  [ -f "$NGINX_SNIPPET" ] && cp -p "$NGINX_SNIPPET" "$BACKUP/snippet"
  [ -f "$ZONE_FILE" ] && cp -p "$ZONE_FILE" "$BACKUP/zone"
  cat > "$ZONE_FILE" <<NGINX
# ${SERVICE}: rate limit zone for ${NGINX_SNIPPET}. Written by OpenMutual's setup_service.sh.
# Next's built files under ${BASE}_next/static/ never change and get cached, so they don't count.
# Pages, form posts and everything else count, per visitor IP.
map \$uri \$${ZONE}_limit_key {
    ~^${BASE}_next/static/  "";
    default                 \$binary_remote_addr;
}
limit_req_zone \$${ZONE}_limit_key zone=${ZONE}:10m rate=20r/s;
NGINX
  cat > "$NGINX_SNIPPET" <<NGINX
# OpenMutual simulation (${SERVICE}). Written by setup_service.sh, rerun it to change this.
location = ${BASE%/} {
    absolute_redirect off;
    return 301 ${BASE}\$is_args\$args;
}
location ${BASE} {
    limit_req zone=${ZONE} burst=80 nodelay;
    limit_req_status 429;
    client_max_body_size 64k;
    # No path after the port, so the app gets the full path. It's built to live under ${BASE}.
    proxy_pass http://127.0.0.1:${WEB_PORT_NOW};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    # With the port, so it matches the browser's Origin and form posts pass Next's check.
    proxy_set_header X-Forwarded-Host \$http_host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    # Plain HTTP, no websockets.
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 60s;
}
NGINX
  if nginx -t 2>"$BACKUP/test.log"; then
    systemctl reload nginx
    echo "nginx checked and reloaded: $NGINX_SNIPPET and $ZONE_FILE"
    rm -rf "$BACKUP"
  else
    cat "$BACKUP/test.log" >&2
    if [ -f "$BACKUP/snippet" ]; then cp -p "$BACKUP/snippet" "$NGINX_SNIPPET"; else rm -f "$NGINX_SNIPPET"; fi
    if [ -f "$BACKUP/zone" ]; then cp -p "$BACKUP/zone" "$ZONE_FILE"; else rm -f "$ZONE_FILE"; fi
    rm -rf "$BACKUP"
    die "nginx -t failed, so both nginx files were put back as they were. The app still runs on 127.0.0.1:${WEB_PORT_NOW}."
  fi
  echo
  echo "Open it at https://<your host>${BASE}"
  echo "Logs:    journalctl -u $WEB_UNIT -f   (or '$SERVICE*' for all three)"
else
  echo
  echo "Web app: http://<this VM>:${WEB_PORT_NOW:-3417}${BASE_NOW:-/}"
  echo "Logs:    journalctl -u $WEB_UNIT -f   (or $WORKER_UNIT, $CHAIN_UNIT)"
fi
