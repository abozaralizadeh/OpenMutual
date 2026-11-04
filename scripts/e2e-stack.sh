#!/usr/bin/env bash
# A separate, throwaway stack for the browser tests: its own chain, data and ports.
# With BASE_PATH set (like /openmutual/), the app is built under that path and sits behind
# scripts/prefix-proxy.mjs on port 3518, the way it runs behind nginx on a shared server.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export DATA_DIR="$ROOT/data/e2e"
export LOG_DIR="$DATA_DIR/logs"
export CHAIN_PORT=8555
export RPC_URL="http://127.0.0.1:$CHAIN_PORT"
export WEB_PORT=3517
export ADMIN_TOKEN="e2e-local-admin"
export WORKER_INTERVAL_MS=500
export PUBLIC_CLOCK=true
export WEB_HOST=127.0.0.1
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"
trap 'kill 0' EXIT
FRESH_CHAIN=1 bash scripts/chain.sh &
for _ in $(seq 1 100); do
  curl -s -o /dev/null -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" && break
  sleep 0.2
done
bash scripts/deploy.sh > /dev/null
npm run build -w web --silent > /dev/null
npm run start -w worker --silent &
npm run start -w web --silent &
if [ -n "${BASE_PATH:-}" ]; then
  ESCAPED_LOG="$DATA_DIR/escaped.log" PROXY_PORT=3518 node scripts/prefix-proxy.mjs &
fi
wait
