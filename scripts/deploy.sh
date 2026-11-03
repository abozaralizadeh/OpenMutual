#!/usr/bin/env bash
# Builds the contracts, deploys a fresh set to the local chain and clears the local database.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
bash scripts/forge.sh build --quiet
npm run gen -w shared --silent
npm run deploy -w shared --silent
