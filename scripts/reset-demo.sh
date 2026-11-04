#!/usr/bin/env bash
# Validate the actual Compose target, snapshot retained global terms, reset all deals and verify.
set -euo pipefail

cd "$(dirname "$0")/.."

exec node_modules/.bin/tsx scripts/reset-demo.ts
