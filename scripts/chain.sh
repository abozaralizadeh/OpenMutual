#!/usr/bin/env bash
# Starts the local test chain. It only listens on this machine.
# Set FRESH_CHAIN=1 to start from nothing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DATA="${DATA_DIR:-data}"
mkdir -p "$DATA"
STATE="$DATA/chain-state.json"
if [ "${FRESH_CHAIN:-0}" = "1" ]; then rm -f "$STATE"; fi
# Run the native binary straight away, so stopping this script stops the chain too.
ANVIL="$(ls node_modules/@foundry-rs/anvil-*/bin/anvil | head -1)"
exec "$ANVIL" \
  --host 127.0.0.1 \
  --port "${CHAIN_PORT:-8545}" \
  --chain-id 31337 \
  --accounts 10 \
  --state "$STATE" \
  --state-interval 15 \
  --silent
