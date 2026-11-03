# Design proposal: planner on OpenAI Agents SDK for TypeScript

Status: proposed, documentation only. Reviewed 2026-11-02. Follow [repository instructions](../../CLAUDE.md), including design approval before implementation and deterministic tests derived from acceptance criteria. This adds `examples/openai-agents`; update [the implementation contract](DESIGN.md) §§1.4, 4, 6, and 7 for dataset verification, managed console launch, and restart handling before implementation in the same change. The parallel [Pi design](PI-HARNESS.md) contains the implementation review and full shared MCP gateway, managed-launch, loader/readiness, and operator-recovery requirements; those requirements also apply here.

## Recommendation

Use `@openai/agents` with one `Agent`, a `Runner`, and local function tools that delegate to `@planner/harness`. Keep the architect console and all six `.mcp.json` servers, adding shared managed launch for the console rather than attaching to an unrelated process. Use OpenAI Responses through the SDK's model provider. Preserve the planner's deterministic engine, graph validators, lexical write guard, and graph-backed decisions.

The requested repository is [`openai/openai-agents-js`](https://github.com/openai/openai-agents-js). This is the TypeScript Agents SDK, separate from the Codex CLI and the managed Agents API. The SDK runs inside this application and owns the model/tool loop. [Source: official SDK overview](https://developers.openai.com/api/docs/guides/agents/sdk).

Do not split the workflow into specialist agents or handoffs for this port. One agent already owns the procedure; the MCP services already separate deterministic responsibilities. No additional model-facing shell, editor, browser, or hosted tools are necessary.

## Baseline and review implications

The source example uses **Vercel AI SDK**, not Anthropic Agent SDK. Its default provider is Anthropic; its optional `openai-compatible` provider is not this Agents SDK integration. It reads the full planner prompt and the 15-tool allowlist from `plugin/agents/planner.md`, launches `.mcp.json` servers, wraps `write-cypher` in `guard.validate`, and caps the tool loop at 200 steps. The gate UI remains independent of the host.

The [source review](PI-HARNESS.md#review-of-the-existing-example) identifies driver/client cleanup gaps, absent alternate-host guard audit logging, permissive malformed-frontmatter handling, and a missing-executor startup check. Implement the shared gateway to address these before adding another host. Existing mocked-model tests establish wiring behavior, not live-model P1–P6 parity.

## Architecture and SDK mapping

```text
planner.md + .mcp.json -> @planner/harness
                              |
               canonical tool descriptors + guarded invoke()
                              |
                 provider-name/schema/result adapters
                              |
                    OpenAI Agent + Runner
                              |
                     Responses model provider
```

| Existing example | Proposed OpenAI implementation |
|---|---|
| `ToolLoopAgent` | `Agent` plus `Runner.run()` |
| `instructions` from planner definition | Same body with deterministic tool-name substitutions |
| AI SDK MCP tool objects | SDK `tool()` wrappers around gateway descriptors/invocation |
| `guardWrites()` | Fresh-context guard inside gateway `invoke`, before the raw MCP call |
| `stopWhen: stepCountIs(200)` | Explicit `maxTurns: 200`, plus run cancellation |
| `onStepFinish` | SDK tool lifecycle/run events mapped to canonical names |
| `result.text` | `result.finalOutput`, only after successful completion |
| Architect gate requests | Existing gate MCP tools and browser console |

The SDK supports runtime-managed stdio MCP connections. We deliberately wrap the existing MCP protocol ourselves for the first port to make guard enforcement and canonical naming identical across hosts. Do not also attach the same servers via `agent.mcpServers`: that would create an alternate tool route and duplicate discovery. Hosted MCP is unnecessary for these local subprocesses. [Source: official MCP integration guide](https://developers.openai.com/api/docs/guides/agents/integrations-observability).

## Tool names: preserve canonical identity through an explicit map

The planner uses names such as `mcp__neo4j-write__write-cypher`. The SDK's current `toFunctionToolName()` replaces non-alphanumeric characters with underscores, including hyphens. Consequently, passing canonical names unchanged and assuming they survive is incorrect. [Source: SDK name conversion](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/utils/tools.ts).

At startup:

1. Build a bijection from canonical names to explicit provider names using the SDK-compatible normalization, for example `mcp__neo4j_write__write_cypher`.
2. Check the chosen model's function-name length/character restrictions and reject collisions; `a-b` and `a_b` must never silently become one binding. Never truncate a name without a collision-safe mapping.
3. Replace exact full tool-name tokens in the prompt with provider names. Keep the source file unchanged; do not re-append or paraphrase the embedded skill. Verify every skill tool reference maps to one declared function.
4. Create each function with its mapped name. Its executor closes over the canonical name and invokes only the gateway. The guard and MCP routing operate on canonical identity, never on a name inferred back from underscores.
5. Show canonical names in application audit/progress events, optionally adding the provider name for diagnosis. Test both directions and the actual serialized model request.

Pi can retain canonical names where supported. Canonical allowlist equality is checked before any host-specific conversion; provider-name equality is checked afterward.

## Tool schemas and result semantics

The risky schema is Neo4j's `{query, params}`, where `params` is an arbitrary map with nested arrays/objects. Blindly converting it to a strict closed object can discard or reject legitimate Cypher parameters. Preserve the discovered MCP JSON Schema and create these wrappers with **`strict: false`** initially. The SDK supports non-strict JSON Schema tools and documents that those inputs are parsed, not locally validated; the gateway must perform schema validation before execution. [Source: SDK function-tool types](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/tool.ts).

Implementation choices:

- Declare the JSON Schema validator directly in `@planner/harness` and pin a compatible published version. Use the discovered schema without stripping arbitrary-map properties or changing optional values to null. Unsupported schemas fail startup explicitly.
- Validate the outer query/params shape before loading guard context. Preserve nested params exactly. `validate` still applies its own template and G1–G9 checks.
- Use non-strict wrappers consistently for the first port. Tighten individual schemas only after proving a lossless conversion against representative MCP inputs. The selected OpenAI model must support this function-tool configuration; treat lack of support as a compatibility failure.
- Return a stable JSON string containing MCP `content`, optional `structuredContent`, and `isError`. A host guard denial includes `{denied: true, reason}`. This keeps witnesses and errors visible rather than depending on implicit object stringification.
- Use `errorFunction: null` for unexpected executor failures so infrastructure failures stop the run. Expected schema/policy errors are explicit tool results the model can repair. Do not convert cancellation or an ambiguous write timeout into a generic success-like tool response.

Contract tests must inspect the generated request schema and make a tool round trip with nested params. Successfully creating an SDK `Agent` is not sufficient proof that its provider accepts the schema.

## Guarding, sequencing, and human gates

The shared gateway is the enforcement boundary:

```text
mapped function call
  -> canonical-name closure
  -> local schema validation
  -> per-run invocation queue
  -> fresh graph context + guard.validate (write-cypher only)
  -> existing MCP server
  -> preserved result/error envelope
```

Queue guard validation and forwarding together. Set `modelSettings.parallelToolCalls = false` where supported, and retain gateway serialization independently of that model setting. Recheck abort state when queued work starts. Serial execution prevents overlap; it does not independently prove that the model followed every planning step.

Agent input/output guardrails do not replace checks immediately before the writer. SDK tool guardrails are available but are unnecessary for the initial adapter because every executable function already routes through the gateway. Preserve fresh ontology/gate context and local guard audit entries. Use the shared gateway's single resolved Neo4j configuration for the guard and every graph-using process, rejecting conflicting child overrides before startup. The existing lexical guard is defense in depth, with the same cross-process validation/write race as the baseline.

The console is included in scope through the [shared managed launch protocol](PI-HARNESS.md#managed-console-launch-and-graph-identity). The example command builds the UI and forks its own console using the resolved graph config, waits for connection/bind readiness over token-correlated child IPC, then starts the host/MCP clients with `GATE_HTTP=off`. Any occupied console port, including a healthy console connected to another graph, is fatal before provider calls or MCP mutations. Do not use HTTP health or legacy `EADDRINUSE` continuation to attach. Console loss aborts the run; managed console/gate validation and lifecycle tests are prerequisites to this adapter.

Continue using `request_approval` and `await_approval`, with the same graph `gate_id`, 50-second default poll, and explicit 60-second MCP deadline. `ontology.propose_term` also waits on a gate. Pending means poll the existing gate; rejection triggers the skill's feedback/new-iteration procedure. Timeouts and cancellation leave graph decisions intact and require reconciliation rather than blind mutation retries.

Do not set `needsApproval: true` on every SDK tool: that would introduce a second approval system detached from `GateDecision`, `Feedback`, and `Override`. The SDK has approval interruptions and resumable state, but the existing browser console remains authoritative here. G8 checks commit approval; frame/select progression remains skill-driven as in the baseline. [Source: official guardrail and human-review guide](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals).

## Runtime, configuration, and lifecycle

Proposed runtime shape, omitting the gateway adapters and resource scope:

```ts
import { Agent, Runner } from '@openai/agents';

const agent = new Agent({
  name: 'Integration planner',
  instructions: mappedInstructions,
  model: modelId,
  tools: mappedTools,
  modelSettings: { parallelToolCalls: false },
});
const runner = new Runner({ tracingDisabled: true });
const result = await runner.run(agent, prompt, {
  maxTurns: 200,
  signal: abortController.signal,
});
```

Pass an explicit cap; do not inherit SDK defaults. SDK turns and AI SDK steps are separate metrics, even when both count model-loop iterations. Handle cap exceptions as incomplete execution, print actionable state information, and exit nonzero. Never call a partial narrative a committed plan; report the graph's actual roadmap/gate state. [Source: official running-agents guide](https://developers.openai.com/api/docs/guides/agents/running-agents).

Configuration for this example is `PLANNER_MODEL=openai:<model-id>` and `OPENAI_API_KEY`. Require an explicit model at first; do not silently select an SDK default or reinterpret the existing `openai-compatible:` configuration. Resolve and validate config before launching MCP children. A custom OpenAI-compatible provider is a separate experimental configuration, requiring explicit base URL, credentials, schema checks, and its own recorded run.

For the MVP keep history in memory during one CLI invocation. Do not mix SDK sessions, `previousResponseId`, and manual history. Restart is **not** a new execution of the skill against existing graph memory: `recall_memory` omits pending gates, while `next_iteration` would advance past the interrupted work. Apply the [shared restart reconciliation/operator procedure](PI-HARNESS.md#restart-reconciliation-and-operator-recovery) before any model call or mutation. Host-only reads list all gate IDs/statuses and plan/ontology/feedback state for explicit `--deal` (default `nimbus`). Any existing target planning state, including a committed roadmap, blocks with `RECOVERY_REQUIRED`; this fresh-run MVP requires operator reset before another CLI run on that deal. Absence of planning state is only one prerequisite: [positive dataset verification](PI-HARNESS.md#positive-dataset-readiness-and-retained-global-terms) must also pass in every new process. Missing deals/findings/sources/links or partial catalog/history return `DATASET_NOT_READY` with zero model calls/mutations, even when a failed reset deleted all planning nodes. Startup verifies exact keyed fixture data/properties and baseline manifest counts read-only; it never loads or repairs data implicitly. Within-run feedback/re-planning remains unchanged.

The gateway pins all invocations to the checked deal: supplied `deal`/Cypher `params.deal` must match, writer params must include it, and `gate_id`-only waits require a trusted lookup confirming that gate belongs to it. Reject mismatched ontology/scheduler/feedback calls as well. A clean check for Nimbus cannot authorize tool calls for another deal with a pending gate.

The operator uses proposed `npm run planner:recover -- inspect --deal nimbus` to recover the original gate ID from the graph, even with no local history and a response lost after gate creation. Inspection creates/approves nothing. Preserving the plan leaves the run blocked; automatic continuation is not supported. An explicit `npm run planner:recover -- reset --deal nimbus --confirm-reset-demo` wraps `scripts/reset-demo.sh` only after other writers/consoles stop and verifies the selected connection is this repository's Compose Neo4j service using its `neo4j` user. Remote/mismatched/unverifiable targets and custom users/databases are refused before deletion; add the pre-deletion check to the reset script itself and keep reset, loader, and reconciliation on that graph. It resets **all per-deal subgraphs** and reloads history/deals, not only the selected deal; catalog/global terms remain. Both reconciliation and positive dataset verification must pass after reload before restart. An incomplete reset/reload stays blocked in a new process, regardless of local logs. No automatic reset, duplicate gate request, synthetic rejection, or direct reserved-label edits are allowed. A future persisted-session design must separately define in-flight mutation reconciliation and exact continuation.

Change loader verification explicitly for retained terms: `graph/load/index.ts` keeps strict exact-manifest mode by default; reset opts into `retain-active-global-terms`, shared with the startup's read-only verifier in proposed `graph/load/verify.ts`. Verify the baseline projection against the **unchanged** manifest and keyed fixture content, and separately validate extra terms as single-label, unique, well-formed active/global `OntologyTerm` nodes with no `deal_code` and required label constraints. Reject other extras and any surviving term edges after reset. Snapshot term metadata before deletion and verify it unchanged afterward. Per-deal approval/evidence links disappear by reset design and are not recreated; retained metadata is structurally verified, not historical approval provenance reconstructed. Keep `graphCounts`/returned physical counts honest and report retained terms separately. Do not ignore all ontology nodes, loosen baseline counts, or regenerate the manifest to fit runtime state. A valid promoted term therefore survives repeated reset/reload without the current `OntologyTerm: expected 0, found 1` failure.

Disable SDK tracing by default and retain local guard/run events. This avoids adding automatic trace exports to the baseline's data flow. An opt-in tracing mode must deliberately choose payload inclusion; tracing is observability, not the graph's decision record. Current SDK configuration exposes `tracingDisabled` and `traceIncludeSensitiveData`. [Source: Runner configuration](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/run.ts).

The CLI owns an AbortController and the Neo4j driver; the gateway owns MCP clients. On `SIGINT`, abort model and queued/in-flight MCP work, wait for settlement, attempt every client close, then attempt driver close regardless of client errors. Cover model/agent construction inside the same cleanup scope. Forwarding cancellation does not roll back a write already committed remotely.

## Files and delivery sequence

| Proposed path | Responsibility |
|---|---|
| `packages/harness/` | Shared gateway specified in the Pi design; implemented once |
| `packages/harness/src/{launch,recovery}.ts`, `scripts/planner-recover.ts` | Shared owned-console protocol, startup reads, operator inspect/reset |
| `scripts/reset-demo.sh` | Refuse mismatched targets before deletion, snapshot retained terms, select explicit retained-term loader mode, require positive verification |
| `graph/load/{index,verify}.ts`, `tests/graph/load.test.ts` | Strict default and retained-term verification modes, keyed dataset readiness, loader regressions |
| `packages/gate/bin/{console,gate-mcp}.ts`, `graph/connection.ts` | Managed console readiness/config, occupied-port refusal, gate mode validation |
| `examples/openai-agents/{package.json,README.md}` | SDK dependencies and run configuration |
| `examples/openai-agents/src/agent.ts` | Agent/Runner construction and bounded execution |
| `examples/openai-agents/src/tools.ts` | Name mapping, schema/result conversion, canonical invocation closures |
| `examples/openai-agents/src/main.ts` | Credentials/config validation, console progress, cancellation, cleanup |
| `tests/examples/openai-agents.test.ts` | Fake SDK model and real disposable MCP tests |
| `tests/gate/console.test.ts`, `tests/examples/recovery.test.ts` | Console graph mismatch and gate-created/response-lost recovery cases |
| root `package.json`, `package-lock.json`, `README.md`, `docs/design/DESIGN.md` | `example:openai-agents`, `planner:recover`, managed launch/recovery contract and instructions |

1. After design approval, update DESIGN §§1.4/4/6/7 and implement/test the shared gateway, managed console launch, loader/readiness verification, and operator recovery once. Have the repository's `spec-reviewer` review guard/gate enforcement changes. Both adapters depend on those contracts, loader, and console changes being complete.
2. Pin a published `@openai/agents` release and test against its actual declarations. Current upstream manifest shows `0.21.0`; this is a source snapshot, not a claim of npm availability or a completed installation. Avoid unpinned main-branch APIs. [Source: package manifest](https://github.com/openai/openai-agents-js/blob/main/packages/agents/package.json).
3. Build name/schema adapters first, then use a fake model to request allowed, denied, pending, rejected, and looping tool sequences without an API key.
4. Run disposable MCP/Neo4j integration tests and existing deterministic skill walks. Then rehearse P1–P6 through the selected live OpenAI model and architect UI, recording actual model/package versions and outcomes.
5. Add runnable README commands only after the example exists. Keep the AI SDK and Claude Code entry points available; any later consolidation gets its own verification.

Proposed invocation after implementation:

```bash
PLANNER_MODEL=openai:<model-id> npm run example:openai-agents -- --deal nimbus "Plan the Nimbus integration."
```

The example owns its console; do not start `demo:ui` separately for managed mode. The model ID is a placeholder to resolve explicitly during implementation. The `brew upgrade --cask codex` fragment in the request is unrelated to either dependency path and is excluded from these designs pending clarification.

## Acceptance

| Area | Required evidence |
|---|---|
| Prompt and exposure | Full embedded skill once; all 15 canonical tools mapped bijectively; no extra tools/handoffs/direct MCP routes |
| SDK request | Actual serialized names match prompt references; normalized-name collisions fail startup; nested arbitrary Cypher params survive schema conversion and execution |
| Guard | Denial makes zero writer calls; valid template makes one; infrastructure failure forwards nothing; commit gates checked for status/deal/iteration; allow/deny audit entries emitted |
| Graph identity | Guard and graph-using children share resolved Neo4j settings; conflicting graph/database overrides fail before startup |
| Console identity | Console A occupies the selected port while host/children target B: refuse before model calls/mutations, never reuse A; same-graph occupied port also refuses; owned readiness/timeout/exit and `GATE_HTTP=on` rejection covered |
| Gate behavior | Pending keeps the same ID; rejection drives feedback/new iteration; ontology activation is read fresh; waits fit the configured timeout |
| Restart recovery | Interrupt gate request or ontology proposal after gate commit/before response; restart without local history reports exact graph IDs and blocks with zero model calls, duplicate gates, or new iterations; cover decided/multiple gates, read-only inspect, confirmation-required reset, failed reset, and successful clean restart |
| Recovery scope | Reject tool-deal/gate-ID mismatches against the startup-selected deal; reset refuses remote/custom-user/mismatched Compose targets before deletion and documents its all-deals scope |
| Failed reload | Delete per-deal data, inject reload failure, then launch a new process without reset history: `DATASET_NOT_READY`, nonzero exit, zero model calls/mutations; cover empty graph, missing deal/evidence/link, partial history, and wrong keys at identical counts |
| Retained promotion | Approve and promote a term through real gates, reset twice successfully, preserve its global active metadata/constraint, verify baseline unchanged and term separately, then permit fresh startup; strict default still rejects extras, retained mode still rejects invalid terms/edges and missing baseline data |
| Loop safety | Endless fake tool requests stop at `maxTurns=3`; result is incomplete and CLI exits nonzero; cancellation prevents queued work |
| Lifecycle | Startup, tool, model, cancellation, and close failures still attempt every acquired client and driver close |
| Graph parity | P1 derive prerequisite; P2 select near-miss; P3 approve ontology; P4 explain feedback-driven changes; P5 refuse/repair cycles; P6 reproduce buy/build outcomes |
| Release evidence | Existing deterministic walks plus live-host rehearsals; target five successful runs per claimed supported configuration; compare graph/validator outcomes, not identical prose |

Automated tests use fake providers and deterministic fixtures; live-model rehearsals stay outside `npm test`. Before declaring implementation complete, follow the full [`/verify` workflow](../../.claude/commands/verify.md), including lint, typecheck, tests, and denylist reporting, plus focused gateway/OpenAI tests and `npm run check:tools` with demo services available. Real graph tests and replay wipe/reload state, so use a disposable database. New-host recovery/console tests and live-model rehearsals remain implementation acceptance criteria; baseline repository checks do not establish the proposed behavior at runtime.

## Choosing between the designs

| Choice | Pi agent-core | OpenAI Agents SDK |
|---|---|---|
| Best reason to choose | Small multi-provider runtime; same-Claude-model baseline comparison | OpenAI SDK loop, typed agent orchestration, and optional SDK observability |
| Main adaptation work | Provider resolution, tool-result mapping, host-owned request budget | Provider tool-name mapping, open-map schemas, SDK result/error semantics |
| Future expansion | Pi coding SDK/TUI if interactive sessions are needed | SDK sessions, tracing, or handoffs if separately justified |
| Shared invariant | Same prompt procedure, MCP allowlist, guard, graph, and architect gates | Same prompt procedure, MCP allowlist, guard, graph, and architect gates |

Implement the gateway first, then Pi for a same-model harness comparison or OpenAI Agents SDK when an OpenAI-native runtime is the immediate goal. Model quality and harness correctness are separate evaluations; neither design establishes live parity before rehearsal.
