# neurosymbolic-planner-neo4j

An integration-planning agent where **the LLM proposes and the graph decides**, built on Neo4j and the official Neo4j MCP server. This is the companion repo for a NODES 2026 talk. All companies, deals, and data are fictional.

The full README (tiers, architecture, gotchas) comes later. The design lives in [`docs/design/DESIGN.md`](docs/design/DESIGN.md).

## Run locally

Requirements: Docker (or Rancher Desktop), Node 24 (`.nvmrc`), macOS or Linux.

```bash
npm ci
docker compose up -d --wait     # Neo4j Community with APOC and GDS
npm run load                    # schema, catalog, Nimbus deal, history; verified against data/manifest.json
npm test                        # wipes and reloads the database
```

## MCP servers (Claude Code)

```bash
npm run mcp:neo4j:install       # pinned official Neo4j MCP server, checksum-verified, into .tools/
```

`.mcp.json` declares three servers. Claude Code asks you to approve them the first time you open the project.

| Server | What it is |
|---|---|
| `neo4j-read` | Neo4j MCP in read-only mode: `get-schema`, `read-cypher` |
| `neo4j-write` | Neo4j MCP with `write-cypher` (guarded by the write guard) |
| `planner-engine` | This repo's pure planning functions (`npm run mcp:engine`) |

They connect with `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD`, which default to the Docker setup. In Claude Code, `/mcp` shows their status.

## The planner agent (Claude Code plugin)

```bash
claude plugin marketplace add .        # this repo is its own marketplace
claude plugin install planner@nodes26
```

Then, in Claude Code inside this repo: `/agents` → **planner** → "Plan the Nimbus integration". Approve each gate in the console at http://127.0.0.1:4646/. The write guard runs on every `write-cypher` call, and its decisions are logged to `.logs/guard.jsonl`.

`npm run check:tools` checks that the skill, the agent's tool allowlist, and the served tools agree.
