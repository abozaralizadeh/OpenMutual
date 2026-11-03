#!/usr/bin/env bash
# Runs everything for local work: a fresh chain, a fresh deployment, the worker and the web app.
# RESUME=1 keeps the chain and data from the last run instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a
[ -f .env ] && . ./.env
set +a
if [ -z "${ADMIN_TOKEN:-}" ] || [ "$ADMIN_TOKEN" = "change-me" ]; then
  ADMIN_TOKEN="$(node -e "console.log(require('crypto').randomBytes(12).toString('hex'))")"
  echo "Admin token for this run: $ADMIN_TOKEN"
fi
export ADMIN_TOKEN
trap 'kill 0' EXIT
if [ "${RESUME:-0}" = "1" ] && [ -f data/deployment.json ]; then FRESH=0; else FRESH=1; fi
FRESH_CHAIN=$FRESH bash scripts/chain.sh &
for _ in $(seq 1 100); do
  curl -s -o /dev/null -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 && break
  sleep 0.2
done
if [ "$FRESH" = "1" ]; then bash scripts/deploy.sh; fi
npm run dev:worker &
npm run dev:web &
wait
