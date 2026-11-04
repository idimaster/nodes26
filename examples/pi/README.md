# Planner on Pi

An optional CLI host using Pi agent-core and pi-ai **1.5.0**, with the existing planner prompt,
15 canonical MCP tools, guarded writes, and architect approvals in the demo console.
It registers no coding, shell, filesystem or ambient tools. The AI SDK example is unchanged.

After `npm run quickstart`, start a fresh, exclusively used demo graph:

```bash
ANTHROPIC_API_KEY=… npm run example:pi -- --deal nimbus "Plan the Nimbus integration."
```

The default is `anthropic:claude-sonnet-5-5`, matching the baseline example. Model lookup is against
the pinned Pi catalog; an unavailable model fails explicitly without selecting a substitute.
Set `PLANNER_MODEL=anthropic:<id>` to choose another catalog model. `ANTHROPIC_BASE_URL` is supported.
The second provider uses `PLANNER_MODEL=openai:gpt-5` with `OPENAI_API_KEY`. Provider credentials are
validated before children launch. Generic OpenAI-compatible gateways are outside this example.

The command builds and owns its console, prints its URL, and waits for your gate decisions there.
Do not run `demo:ui` separately. An occupied console port is fatal; select another explicitly with
`--port 4647`. The console, guard and MCP children share one verified graph configuration.
`--max-steps 200` bounds **provider requests**, including tool follow-ups. Exhaustion or Ctrl-C
exits nonzero, preserves graph state, closes children and never retries an uncertain mutation.
Use `--help` for CLI syntax. `GUARD_LOG` overrides the default `.logs/guard.jsonl` audit path;
records include host/run/tool/deal/rules, without full tool parameters or credentials.

## Interrupted or previously completed runs

A new process only starts on a clean selected deal with positively verified fixture data.
`RECOVERY_REQUIRED` means the graph contains planning state; `DATASET_NOT_READY` means fixture
data, values, relationships or required constraints are missing/invalid. Startup never reloads,
resets, resumes, recreates a lost gate, or asks the skill to infer its ID.

```bash
npm run planner:recover -- inspect --deal nimbus
# Explicitly accept the ALL-DEALS deletion scope described below:
npm run planner:recover -- reset --deal nimbus --confirm-reset-demo
```

Inspect is read-only and lists gate IDs/statuses, iterations, roadmaps, scoped terms, open feedback
and active overrides from the graph, even without local session files. Approving an interrupted
gate does not clear the fresh-run block. Preserve wanted reports/decisions before resetting.

Reset supports only this repository's **local Compose Neo4j service/default user/database**.
It verifies the Docker endpoint, published port, credentials, and matching host/container database
IDs before deleting anything. It refuses remote or differently forwarded targets and active
managed runs. **It deletes all per-deal subgraphs and reloads all deals/history**; `--deal` selects
the readiness check, not a narrower reset. Catalog and active global term metadata/constraints
remain, while their per-deal approval/evidence history is deleted. Metadata is compared before
and after reset; fixture readiness is checked again. A failed reload stays blocked on a later
process. `scripts/reset-demo.sh` uses the same checks.

Exclusive use of the disposable graph is an operator prerequisite; the local managed-run lock is
not distributed locking. Guard validation and remote writes remain separate operations.

## Verification and provider status

```bash
npm test -- packages/harness/test tests/examples/pi.test.ts tests/examples/pi-integration.test.ts tests/examples/recovery.test.ts tests/graph/readiness.test.ts
```

Tests use a scripted provider with the real MCP servers and owned console, including the recorded
Nimbus roadmap and feedback-driven second iteration. Tests reload the disposable demo database.
No live model is called by `npm test`.

| Provider | Automated adapter tests | Live P1–P6 rehearsals |
|---|---|---|
| Anthropic | Deterministic provider/configuration tests | Not run; experimental |
| OpenAI | Deterministic provider/configuration tests | Not run; experimental |

Neither provider is claimed supported until the design's live rehearsals pass. See
[PI-HARNESS.md](../../docs/design/PI-HARNESS.md) for the acceptance contract.
