#!/usr/bin/env bash
# Sets up or updates the OpenMutual simulation on a Linux VM (Ubuntu or Debian).
#
#   First run:   sudo bash setup_service.sh   installs everything and starts it
#   Later runs:  sudo bash setup_service.sh   updates, rebuilds and restarts
#
# It keeps the chain and data between runs. Add --fresh to start over with a new chain.
#
# Logs:
#   journalctl -u openmutual-chain.service -f
#   journalctl -u openmutual-worker.service -f
#   journalctl -u openmutual-web.service -f
#   Size-limited copies (15 MB each at most) in $APP_DIR/logs, easy to copy back for debugging:
#   scp -r user@vm:/path/to/OpenMutual/logs ./vm-logs
#
# Test money on a local chain only. The chain listens on 127.0.0.1 and is never reachable
# from outside. Nothing here touches a public network.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it with sudo: sudo bash setup_service.sh"
  exit 1
fi

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"
NODE_MAJOR=24
FRESH=0
[ "${1:-}" = "--fresh" ] && FRESH=1

say() { printf '\n== %s\n' "$1"; }
as_app() { sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && $1"; }

say "System packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  say "Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
node --version

say "Settings"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  TOKEN="$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"
  sed -i "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$TOKEN/" "$APP_DIR/.env"
  # On a shared VM, lock the clock to the admin by default.
  sed -i "s/^PUBLIC_CLOCK=.*/PUBLIC_CLOCK=false/" "$APP_DIR/.env"
  chown "$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "Made .env with a new admin token. Read it with: sudo grep ADMIN_TOKEN $APP_DIR/.env"
fi
mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
chown "$APP_USER" "$APP_DIR/data" "$APP_DIR/logs"

say "Stopping services"
systemctl stop openmutual-web openmutual-worker openmutual-chain 2>/dev/null || true

say "Install and build"
as_app "npm ci --no-audit --no-fund"
as_app "bash scripts/forge.sh build --quiet"
as_app "npm run gen -w shared --silent"
as_app "npm run build -w web --silent"

say "Services"
ENV_LINE="EnvironmentFile=$APP_DIR/.env"
cat > /etc/systemd/system/openmutual-chain.service <<UNIT
[Unit]
Description=OpenMutual local test chain (127.0.0.1 only)
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
$ENV_LINE
ExecStart=/usr/bin/env bash scripts/chain.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/openmutual-worker.service <<UNIT
[Unit]
Description=OpenMutual worker (results, settling, withdrawals)
After=openmutual-chain.service
Requires=openmutual-chain.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
$ENV_LINE
Environment=NODE_ENV=production
ExecStart=/usr/bin/env npm run start -w worker --silent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/openmutual-web.service <<UNIT
[Unit]
Description=OpenMutual web app
After=openmutual-chain.service
Requires=openmutual-chain.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
$ENV_LINE
Environment=NODE_ENV=production
ExecStart=/usr/bin/env npm run start -w web --silent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable openmutual-chain openmutual-worker openmutual-web >/dev/null

say "Chain"
if [ "$FRESH" = "1" ]; then
  rm -f "$APP_DIR/data/chain-state.json" "$APP_DIR/data/deployment.json"
fi
systemctl start openmutual-chain
for _ in $(seq 1 100); do
  curl -s -o /dev/null -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 && break
  sleep 0.2
done

if [ ! -f "$APP_DIR/data/deployment.json" ]; then
  say "First deployment"
  as_app "set -a; . ./.env; set +a; npm run deploy -w shared --silent"
else
  echo "Keeping the existing chain and data. Use --fresh to start over."
fi

say "Starting"
systemctl restart openmutual-worker openmutual-web
sleep 3
systemctl --no-pager --lines=0 status openmutual-chain openmutual-worker openmutual-web | grep -E '●|Active:'

PORT="$(grep -E '^WEB_PORT=' "$APP_DIR/.env" | cut -d= -f2)"
echo
echo "Web app: http://<this VM>:${PORT:-3417}"
echo "Logs:    journalctl -u openmutual-web.service -f   (or -worker, -chain)"
