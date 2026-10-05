#!/usr/bin/env bash
# npm run quickstart: from a fresh clone to Tier 0 (replay, no LLM). Safe to re-run.
# Checks the prerequisites, installs dependencies and the pinned Neo4j MCP server, starts Neo4j,
# loads the demo data, and builds the demo UI. Every failure says what to do; nothing is skipped silently.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\nquickstart: %s\n' "$*" >&2; exit 1; }
start=$(date +%s)

step "Checking prerequisites"
command -v node >/dev/null || fail "Node.js is not installed. Install Node $(cat .nvmrc) (for example: nvm install)."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" == "$(cat .nvmrc)" ]] || fail "Node $(node -v) found; this repo needs Node $(cat .nvmrc). Run: nvm use"
command -v docker >/dev/null || fail "Docker is not installed. Install Docker Desktop or Rancher Desktop."
docker info >/dev/null 2>&1 || fail "Docker is not running (Rancher Desktop: start it, and check that ~/.rd/docker.sock exists)."
docker compose version >/dev/null 2>&1 || fail "'docker compose' is not available. Update Docker, or install the compose plugin."
echo "Node $(node -v), $(docker --version)"

step "Installing dependencies"
if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json ]]; then
  npm ci --no-audit --no-fund
else
  echo "node_modules is up to date"
fi

step "Installing the pinned Neo4j MCP server"
npm run -s mcp:neo4j:install

step "Starting Neo4j (Community, with APOC and GDS)"
docker compose up -d --wait || fail "Neo4j did not become healthy. See: docker compose logs neo4j"

step "Loading the demo data"
npm run -s load

step "Building the demo UI"
npm run -s ui:build

printf '\n\033[1mReady (Tier 0) in %ss.\033[0m Next, in two terminals:\n' "$(( $(date +%s) - start ))"
echo "  npm run demo:ui                       # then open http://127.0.0.1:${GATE_PORT:-4646}/?deal=nimbus"
echo "  npm run demo:replay -- --delay 800    # replays the golden Nimbus run into the page"
