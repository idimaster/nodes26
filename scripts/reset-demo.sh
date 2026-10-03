#!/usr/bin/env bash
# Wipe per-deal subgraphs, reload catalog/deals/history, and verify counts.
# Global knowledge (catalog) is kept; the loaders MERGE it idempotently.
set -euo pipefail

cd "$(dirname "$0")/.."

NEO4J_PASSWORD="${NEO4J_PASSWORD:-planner-demo}"

cypher() {
  docker compose exec -T neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" --format plain "$@"
}

has_script() {
  node -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)"
}

if ! docker compose ps --status running --services | grep -qx neo4j; then
  echo "reset-demo: neo4j is not running; start it with 'npm run db:up'" >&2
  exit 1
fi

echo "reset-demo: wiping per-deal subgraphs"
cypher <<'CYPHER'
MATCH (n)
WHERE n:Deal
   OR n.deal_code IS NOT NULL
   OR (n:OntologyTerm AND n.scope <> 'global')
CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS;
MATCH (n) WHERE n:Deal OR n.deal_code IS NOT NULL RETURN count(n) AS remaining_per_deal_nodes;
CYPHER

# The loaders (T1.4) verify node and relationship counts against data/manifest.json.
if ! has_script load; then
  echo "reset-demo: 'npm run load' is not defined yet (see docs/milestones/M1.md T1.4); cannot reload" >&2
  exit 1
fi
npm run --silent load

echo "reset-demo: done"
