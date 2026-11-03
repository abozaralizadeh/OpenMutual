#!/usr/bin/env bash
# Runs forge from the local npm install.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"
exec node "$ROOT/node_modules/@foundry-rs/forge/bin.mjs" "$@"
