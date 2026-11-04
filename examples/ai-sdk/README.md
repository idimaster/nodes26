# Planner on the AI SDK

An optional TypeScript host using Vercel AI SDK **7.0.128** and `ToolLoopAgent`.
It loads the full embedded planner skill and fifteen canonical tool names from
[`plugin/agents/planner.md`](../../plugin/agents/planner.md), connects to the servers in
[`.mcp.json`](../../.mcp.json), and wraps `write-cypher` with the existing write guard.
Architect decisions happen in the demo console.

## Run

Run `npm run quickstart` from the repository root to install dependencies, prepare Neo4j and
load the demo data. Use a disposable graph exclusively while running the planner or graph tests.
Start the console in one terminal:

```bash
npm run demo:ui
```

In another terminal, configure a provider key and start the planner from the repository root:

```bash
export ANTHROPIC_API_KEY='your-api-key'
npm run example:ai-sdk -- "Plan the Nimbus integration."
```

The default model is `anthropic:claude-sonnet-5-5`; the default prompt is
`Plan the Nimbus integration.`. The CLI joins all arguments into the prompt. It has no option
parser: `--help`, `--deal`, and `--max-steps` are not supported flags.

Open the URL printed by the console and approve or reject gates there. The planner prints tool
names after each model step, then final text and the step count. The console runs separately;
the AI SDK command does not start or own it.

## Model configuration

| `PLANNER_MODEL` | Credentials | Optional endpoint | API |
|---|---|---|---|
| `anthropic:<model-id>` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | Anthropic provider |
| `openai:<model-id>` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | Responses |
| `openai-compatible:<model-id>` | `OPENAI_COMPATIBLE_API_KEY` (usually required) | `OPENAI_COMPATIBLE_BASE_URL` (**required**) | Chat Completions; Responses for `https://api.openai.com` |

For OpenAI, set the key in the shell and choose a model explicitly:

```bash
export OPENAI_API_KEY='your-api-key'
PLANNER_MODEL=openai:gpt-6-luna npm run example:ai-sdk -- "Plan the Nimbus integration."
```

The OpenAI adapter is pinned to `@ai-sdk/openai` **4.0.84**, matching the repository's
`@ai-sdk/provider` **4.0.22** interface. It explicitly selects `.responses(modelId)`.
[OpenAI's GPT-6 Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna)
requires Responses for function tools with reasoning; Chat Completions only permits those tools
when reasoning effort is `none`.

Existing `openai-compatible:` configurations pointing to `https://api.openai.com/v1` also use
Responses and retain their compatible-provider URL/key settings. Other compatible endpoints keep
the Chat Completions adapter. Such endpoints must support function tools and the selected model's
settings; changing the model ID does not establish endpoint compatibility.

## Tool loop and approvals

Only tools in the planner's canonical allowlist are exposed to the model. Startup fails if an
allowlisted tool is missing. Before each `write-cypher` call, the wrapper loads graph context and
validates the query and parameters. A denial returns `{ denied: true, reason }` to the model
without forwarding the write. Other tools keep their existing MCP implementations and gate rules.

The loop stops after **200 AI SDK steps** by default. Programmatic callers of `createPlanner`
can set `maxSteps`; the CLI does not expose that setting. A step limit is a loop bound, not a
provider-attempt budget or evidence that a roadmap was committed. Check the console and graph for
actual approval and roadmap state.

This example uses direct AI SDK MCP connections. The managed console, startup readiness checks,
deal binding, audit integration, retry circuit and interruption handling described in the
[Pi](../pi/README.md) and [OpenAI Agents](../openai-agents/README.md) examples belong to their shared
harness. This entry point has no custom retry/circuit policy or persisted conversation resume.
After generation returns or throws, its `finally` block closes MCP clients and the driver;
signal handling and startup/cleanup failure variants have not been exhaustively verified.

## Interrupted runs

Stop the planner before inspecting or resetting a previously used graph. Inspect reads graph
state, including gate IDs/statuses and roadmaps:

```bash
npm run planner:recover -- inspect --deal nimbus
```

This AI SDK entry point does not enforce the managed hosts' fresh-run check or automatically resume
an interrupted conversation. Preserve wanted decisions/reports before choosing a reset.
The shared reset command verifies the local Compose target and **deletes all per-deal subgraphs
and reloads all deals/history**. `--deal` selects the readiness check, not the deletion scope.
Catalog and active global term metadata/constraints remain; per-deal approval/evidence history is
deleted. To explicitly accept that scope:

```bash
npm run planner:recover -- reset --deal nimbus --confirm-reset-demo
```

## Verification and provider status

```bash
npm test -- tests/examples/ai-sdk.test.ts tests/examples/ai-sdk-model.test.ts
```

The MCP integration tests clear and reload their database. Run them against a disposable instance.
They use a mock language model with the real MCP servers; provider tests use mocked HTTP responses.
No live model is called by these tests.

| Provider | Automated evidence | Live P1–P6 rehearsals |
|---|---|---|
| Anthropic | Model selection; shared mock-model MCP/guard/step-cap tests | Not established by this verification |
| OpenAI | Responses endpoint, credentials, custom base URL and function-call round trip | Not run; experimental |
| Other OpenAI-compatible servers | Chat Completions endpoint with mocked HTTP | Not run; experimental |

See [VERIFICATION.md](VERIFICATION.md) for recorded results and coverage limits, and
[T5.3](../../docs/milestones/M5.md#t53-optional-examplesai-sdk) for the live-provider acceptance criteria.
