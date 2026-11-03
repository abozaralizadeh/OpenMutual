#!/usr/bin/env bash
# Runs every test. Contracts are always rebuilt first, so nothing runs against an old build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "== Contracts"
bash scripts/forge.sh test --summary 2>&1 | tail -20
npm run gen -w shared --silent
echo "== Shared"
npm test -w shared --silent
echo "== Worker"
npm test -w worker --silent
echo "== Web, end to end"
npm run e2e -w web --silent
