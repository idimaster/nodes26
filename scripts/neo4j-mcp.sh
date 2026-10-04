#!/usr/bin/env bash
# Launches the pinned Neo4j MCP server for .mcp.json. Connection settings come from the same
# variables as the rest of the repo (defaults match docker-compose.yml), so no secret lives in
# .mcp.json. Read-only mode is set only by the --read-only flag each .mcp.json entry passes.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bin="${NEO4J_MCP_BIN:-$root/.tools/neo4j-mcp/neo4j-mcp}"
if [[ ! -x "$bin" ]]; then
  echo "neo4j-mcp is not installed at ${bin}; run: npm run mcp:neo4j:install" >&2
  exit 1
fi

export NEO4J_MCP_URI="${NEO4J_URI:-neo4j://localhost:7687}"
export NEO4J_MCP_USERNAME="${NEO4J_USERNAME:-neo4j}"
export NEO4J_MCP_PASSWORD="${NEO4J_PASSWORD:-planner-demo}"
export NEO4J_MCP_DATABASE="${NEO4J_DATABASE:-neo4j}"
export NEO4J_MCP_TELEMETRY=false # upstream default is true; this public demo sends nothing
unset NEO4J_MCP_READ_ONLY
exec "$bin" "$@"
