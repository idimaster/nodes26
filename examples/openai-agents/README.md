# Planner on OpenAI Agents SDK

An experimental TypeScript host using `@openai/agents` **0.21.0** and the OpenAI client **7.19.0**.
One Agent/Runner uses the full embedded planner skill and the existing fifteen MCP tools through
`@planner/harness`. The harness serializes calls, validates inputs and guards writes with fresh graph
context. The browser console remains authoritative for architect decisions. SDK tracing is disabled.

After `npm run quickstart`, choose an OpenAI model explicitly and use a clean disposable graph:

```bash
PLANNER_MODEL='openai:<model-id>' OPENAI_API_KEY=… npm run example:openai-agents -- --deal nimbus "Plan the Nimbus integration."
```

Replace `<model-id>` with a Responses model available to your account that supports non-strict
function tools. There is no default model or fallback. `openai-compatible:` configurations and
custom `OPENAI_BASE_URL`/`OPENAI_WEBSOCKET_BASE_URL` endpoints are unsupported.

The command builds and owns its console and prints its URL. Do not start `demo:ui` separately.
An occupied port is fatal, including a console using the same graph; choose another with `--port 4647`.
Console loss aborts the run. Console, MCP children and guard share one verified graph configuration.

`--max-turns 200` bounds SDK turns; these are distinct from Pi provider requests or AI SDK steps.
Exhaustion, cancellation and infrastructure errors exit nonzero and suppress partial final text.
After the SDK run, the CLI prints read-only graph state, including gate IDs/statuses and roadmaps;
if that read fails it reports state as unavailable and supplies the selected-deal inspect command.
SIGINT/SIGTERM cancel model and MCP work, then close the provider, gateway, driver and owned console.
A remotely committed write is not rolled back by cancellation; uncertain mutations are never retried
automatically. Successful SDK completion alone is not evidence that a roadmap was committed: use the
console/graph to verify the actual plan. Progress and `GUARD_LOG` (default `.logs/guard.jsonl`) use
canonical tool names; provider function names use collision-checked underscores.

## Existing or interrupted planning state

A new process verifies fixture content and requires a clean selected deal before model calls or MCP
startup. Existing planning state, including completed plans and pending/decided gates, yields
`RECOVERY_REQUIRED`. Invalid/missing fixture nodes, properties, edges, history or constraints yield
`DATASET_NOT_READY`. Startup does not load data, reset, resume or recreate lost gates.

```bash
npm run planner:recover -- inspect --deal nimbus
# Explicitly accept the ALL-DEALS reset scope:
npm run planner:recover -- reset --deal nimbus --confirm-reset-demo
```

Inspect is read-only and recovers graph gate IDs even without a local transcript. Approving a gate
after interruption does not clear the fresh-run block. Preserve wanted results before resetting.
Reset supports only this repository's local Compose service/default user/database. It verifies the
endpoint, credentials and database identity, and refuses active managed runs or unverifiable targets.
**It deletes all per-deal subgraphs and reloads every deal/history**, regardless of `--deal`.
Active global term metadata/constraints remain; their per-deal approval/evidence history is deleted.
Failed reload remains blocked on the next process. See the [shared recovery details](../pi/README.md).
Exclusive use of the disposable graph is required; the local run lock is not distributed locking.

## Verification

```bash
npm test -- tests/examples/openai-agents.test.ts tests/examples/openai-agents-cli.test.ts tests/examples/openai-agents-integration.test.ts packages/harness/test tests/examples/recovery.test.ts tests/graph/readiness.test.ts
```

Tests use scripted SDK models and a fake Responses HTTP transport, plus real disposable MCP/Neo4j
and architect HTTP decisions. They reload demo data. `npm test` never calls a live model.
Live P1–P6 rehearsals and five successful runs of a named model configuration remain pending;
automated adapter checks do not establish live planning quality or provider support.
See [verification evidence](VERIFICATION.md) and the [design contract](../../docs/design/OPENAI-AGENTS-SDK.md).
