#!/usr/bin/env bash
# T5.1 acceptance: time a fresh clone to Tier 0, isolated from your working copy and database.
# Copies the repo's files (tracked and not-ignored untracked, as a clone after commit would have them)
# into a temp dir, then runs `npm run quickstart` and `npm run demo:replay` with a cold npm cache, a fresh
# Neo4j container and volumes (so APOC/GDS download again), and a fresh Neo4j MCP download.
# The Neo4j image is reused when it is already pulled; --pull removes nothing but reports a timed pull.
#   LIMIT_SECONDS   fail above this (default 300)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
limit="${LIMIT_SECONDS:-300}"
image="$(sed -n 's/^ *image: *//p' "$root/docker-compose.yml" | head -1)"
work="$(mktemp -d)"
export COMPOSE_PROJECT_NAME=planner-fresh NEO4J_CONTAINER=planner-fresh-neo4j NEO4J_HTTP_PORT=17474 NEO4J_BOLT_PORT=17687
export NEO4J_URI=neo4j://localhost:17687 npm_config_cache="$work/npm-cache" GATE_PORT=14646

cleanup() {
  (cd "$work/repo" 2>/dev/null && docker compose down -v >/dev/null 2>&1) || true
  rm -rf "$work"
}
trap cleanup EXIT

if [[ "${1:-}" == "--pull" ]]; then
  t=$(date +%s); docker pull -q "$image" >/dev/null; echo "fresh-clone-check: docker pull ${image}: $(( $(date +%s) - t ))s"
fi
docker image inspect "$image" >/dev/null 2>&1 && cached="cached" || cached="not cached (pulled during the run)"

mkdir -p "$work/repo"
(cd "$root" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$work/repo"

cd "$work/repo"
start=$(date +%s)
npm run -s quickstart
npm run -s demo:replay
elapsed=$(( $(date +%s) - start ))

echo
echo "fresh-clone-check: Tier 0 in ${elapsed}s (limit ${limit}s); Neo4j image ${image} ${cached}"
(( elapsed <= limit )) || { echo "fresh-clone-check: over the limit" >&2; exit 1; }
