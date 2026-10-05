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
claude plugin marketplace add ./       # this repo is its own marketplace (the ./ is required)
claude plugin install planner@nodes26
```

Start the demo UI in a terminal and keep it open: `npm run demo:ui` → http://127.0.0.1:4646/?deal=nimbus. It builds the page if needed, then serves the graph (scenes `1` Knowledge, `2` Plan, `3` Decisions), the gate panel, and the tables (`4`). (`npm run console` is an alias. The `gate` MCP server also serves the page while a Claude Code session runs, unless `GATE_HTTP=off`.)

Then start a Claude Code session *as* the planner agent, from the repo root (plugin agents are named `<plugin>:<agent>`):

```bash
claude --agent planner:planner
```

and ask: "Plan the Nimbus integration." Approve each gate in the console. (Inside an ordinary session you can also ask Claude to "use the planner:planner agent to plan the Nimbus integration".) The write guard runs on every `write-cypher` call, and its decisions are logged to `.logs/guard.jsonl`.

`npm run check:tools` checks that the skill, the agent's tool allowlist, and the served tools agree.

## Tier 0: replay without an LLM

```bash
npm run demo:ui                                  # in one terminal: the page at http://127.0.0.1:4646/?deal=nimbus
npm run demo:replay -- --delay 800               # in another: wipe, reload, and replay the golden Nimbus run
npm run demo:replay -- data/replays/nimbus-p4.jsonl   # the rejection → iteration 2 story
```

A recording (`data/replays/*.jsonl`) holds a run's state-changing MCP calls (writes, gates, feedback, scheduling), the architect's decisions, and the graph counts and validator verdicts the run ended with. Replay re-sends every call to the same MCP servers, runs each write through the guard first, makes the recorded decisions while the gate tools wait, and exits 1 if the final counts or verdicts differ. `tests/replay/golden.test.ts` does the same in CI.

The committed recordings come from the scripted skill walks (`npm run record:golden`, header `source: "skill-walk"`). To record a live LLM run instead, right after the session ends and before anything resets the graph:

```bash
npm run record:session -- --transcript ~/.claude/projects/<project>/<session>.jsonl --out data/replays/nimbus-v1.jsonl
```

Only MCP tool arguments and results are kept, not prompts or chat.

## Neo4j Browser

Open http://localhost:7474 (user `neo4j`, password from `.env.example`). Drag `browser/style.grass` onto Browser for the demo palette, and import `browser/favorites.cypher` as favorites (set `:param deal => "nimbus"` and `:param iteration => 1` first). In Browser settings, turn **off** "Connect result nodes", and zoom to 125–150%.
