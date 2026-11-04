# Planner on OpenAI Agents SDK

An experimental TypeScript host using `@openai/agents` **0.21.0** and the OpenAI client **7.19.0**.
One Agent/Runner uses the full embedded planner skill and the existing fifteen MCP tools through
`@planner/harness`. The harness serializes calls, validates inputs and guards writes with fresh graph
context. The browser console remains authoritative for architect decisions. SDK tracing is disabled by default.

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
Model requests use the Agents SDK's retry policies with up to **four attempts per turn**; the printed
request total includes those attempts. Native HTTP-client retries are disabled to keep one retry
owner. Transient network/HTTP2 session errors, HTTP 408/409/429 and 5xx use SDK exponential backoff
with jitter (1-second initial, 8-second cap). Valid Retry-After hints are honored up to 60 seconds;
longer hints stop the run rather than retrying early.

Three consecutive eligible failures open a circuit for **30 seconds**, or a longer permitted
server delay. One probe follows: success resets the circuit, failure exits incomplete. CLI messages
show `retry`, `circuit_open`, `circuit_probe`, `circuit_closed` and `circuit_failed` with the selected
model and total attempt count. Cancellation interrupts SDK backoff/cooldown. Authentication, invalid
requests, quota/billing, certificate failures, provider vetoes and unsafe/stateful replay are terminal.
Only the current model request is retried with prior tool results intact; MCP calls and workflows
are never replayed. The circuit is local to one CLI invocation.

Exhaustion, cancellation and infrastructure errors exit nonzero and suppress partial final text.
After the SDK run, the CLI prints read-only graph state, including gate IDs/statuses and roadmaps;
if that read fails it reports state as unavailable and supplies the selected-deal inspect command.
SIGINT/SIGTERM cancel model and MCP work, then close the provider, gateway, driver and owned console.
A remotely committed write is not rolled back by cancellation; uncertain mutations are never retried
automatically. Successful SDK completion alone is not evidence that a roadmap was committed: use the
console/graph to verify the actual plan. Progress and `GUARD_LOG` (default `.logs/guard.jsonl`) use
canonical tool names; provider function names use collision-checked underscores.

Connection failures include bounded error-class and nested transport-code diagnostics (for example
`APIConnectionError`, `ECONNRESET` or `ETIMEDOUT`). Nested messages, URLs, headers and credentials are
not printed. A connection failure does not identify its cause without those transport details;
the retry policy handles eligible failures in the current conversation and never restarts the workflow automatically.

## Optional SDK tracing

Use the same model/key configuration and add `--trace` to export diagnostic traces to OpenAI:

```bash
npm run example:openai-agents -- --trace --deal nimbus "Plan the Nimbus integration."
```

The CLI prints a trace ID, the [Traces dashboard](https://platform.openai.com/traces), the guard audit
run ID and the actual Node/undici versions. Node 26.8.2 is recorded as such; enabling tracing does not
change your runtime. The repository's standard verification runtime remains Node 24.21.0.

SDK model/tool spans are supplemented by physical-attempt, canonical-tool/gate-wait, retry, backoff,
circuit and completion spans. Byte counts help identify growing model inputs without recording their
contents. Errors retain classifications, transport codes, HTTP status and request IDs when available.
Default tracing remains off. `--trace` conflicts with `OPENAI_AGENTS_DISABLE_TRACING=1`/`true` and fails
before launch in that case.

`traceIncludeSensitiveData` always stays **false**. A processor redacts payload fields and raw SDK
exception messages before export; prompts, instructions, Cypher parameters, tool results and API keys
are excluded. Custom span data contains only diagnostic metadata. The CLI owns one redacting export
route, with one SDK ingest attempt per batch. It gives SDK shutdown up to **five seconds** to drain
the queue/abort active exports after planner resources close, including failure and Ctrl-C. Export
failure does not change the planner result or replay a model/tool call. Dashboard delivery is best effort.

Tracing helps locate failures and compare runtimes; it does not repair a broken connection or resume
an interrupted plan. Graph gates and local guard audit remain the decision record.

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
npm test -- tests/examples/openai-agents.test.ts tests/examples/openai-agents-cli.test.ts tests/examples/openai-agents-reliability.test.ts tests/examples/openai-agents-tracing.test.ts tests/examples/openai-agents-integration.test.ts packages/harness/test tests/examples/recovery.test.ts tests/graph/readiness.test.ts
```

Tests use scripted SDK models and a fake Responses HTTP transport, plus real disposable MCP/Neo4j
and architect HTTP decisions. They reload demo data. `npm test` never calls a live model.
Live P1–P6 rehearsals and five successful runs of a named model configuration remain pending;
automated adapter checks do not establish live planning quality or provider support.
See [verification evidence](VERIFICATION.md) and the [design contract](../../docs/design/OPENAI-AGENTS-SDK.md).
