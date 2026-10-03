# CLAUDE.md: neurosymbolic-planner-neo4j

A public, open-source demo: an integration-planning agent where **the LLM proposes and the graph decides**. Neo4j is reached through the official Neo4j MCP server. This is the companion repo for a NODES 2026 talk, and it will be **public**.

## Source of truth
- `docs/design/DESIGN.md`: the implementation contract (ontology, tool contracts, guard rules G1–G9, gates, validators, workflow). If code and DESIGN disagree, fix the code or update DESIGN in the same change.
- `config/ontology.json`: the machine-readable ontology (DESIGN §1.4); keep it in lockstep with DESIGN §1.1–§1.2.
- `docs/design/DATA.md`: the fictional data contract and planted situations P1–P6.
- `docs/design/GOTCHAS.md`: the 9 reproducible gotchas.
- `docs/milestones/M1.md` … `M5.md`: ordered tasks with acceptance criteria and suggested models.

## How to work
1. Work one milestone task at a time (`/task T2.4`), or a whole milestone (`/milestone M2`).
2. For non-trivial tasks, **plan first**: propose a design against the acceptance criteria and wait for approval.
3. **Write tests first**, derived from the acceptance criteria. Implement until they're green.
4. Run `/verify` before declaring a task done. Use the `spec-reviewer` subagent for a second check on correctness-critical tasks (guard, gate, validators, scheduling).
5. Keep diffs focused; one task per commit, with message `T<id>: <title>`.

## Hard rules
- **Public repo hygiene:** the demo scenario and data never name real companies, products, people, or deals, in code, data, docs, or commit messages. All scenario data is fictional (Harborline, Nimbus Ledger, Tidewater, Quarry). Naming the tooling this repo is built on (Neo4j, APOC, GDS, MCP, Claude Code) and public standards (SAML, OIDC, SCIM) is fine. The denylist is authoritative and must stay green.
- **Engine is pure:** `packages/engine` has no I/O and never touches Neo4j.
- **Reserved labels** (`GateDecision`, `Feedback`, `Override`, `Actual`, `OntologyTerm`) are written only by the gate server, the ontology server, and the loaders. Never by agent-facing Cypher.
- **Cypher style:**
  - parameters only (no string interpolation);
  - MERGE on constraint keys, nodes before relationships;
  - every variable-length pattern bounded (≤ 10);
  - every write ends with `RETURN`;
  - every per-deal query takes `$deal`;
  - validators use `OPTIONAL MATCH` for the examined set and return one row.
- **No silent fallbacks:** if a capability probe fails (e.g. GDS `dag` procedures), log it and use the documented fallback.
- **Determinism:** generated data uses a fixed seed; tests must not depend on an LLM.

## Stack
TypeScript (strict), Node LTS (`.nvmrc`), npm workspaces, vitest, zod, `neo4j-driver`, `@modelcontextprotocol/sdk`. Neo4j runs in Docker/Rancher with APOC and GDS, at pinned versions.

## Commands
- `npm test`: unit and graph tests (needs `docker compose up -d`).
- `npm run generate`: regenerate demo data.
- `npm run load`: apply the schema, then load the catalog, deals, and history.
- `npm run demo:replay`: Tier 0 replay, with no LLM.
- `./scripts/reset-demo.sh`: wipe per-deal subgraphs and reload.
