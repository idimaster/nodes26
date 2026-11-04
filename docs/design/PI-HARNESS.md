# Design proposal: planner on Pi

Status: initial implementation with deterministic integration coverage; live provider rehearsals pending. Reviewed 2026-11-02. Follow [repository instructions](../../CLAUDE.md), including deterministic tests derived from acceptance criteria. This design preserves the ontology, planning procedure, and gate decisions, and adds managed console launch and explicit restart handling. [The implementation contract](DESIGN.md) covers dataset verification, launch, and recovery. The alternative is [OpenAI Agents SDK for TypeScript](OPENAI-AGENTS-SDK.md).

## Recommendation

Add `examples/pi` using Pi's `pi-agent-core` runtime and `pi-ai` provider layer. Embed one planner agent with exactly the existing MCP allowlist. This is the minimal Pi harness integration; an interactive Pi CLI extension can follow if terminal sessions become a requirement.

The requested Pi is assumed to mean Mario Zechner's toolkit, formerly `badlogic/pi-mono`, which now redirects to [`earendil-works/pi`](https://github.com/earendil-works/pi). Current upstream package names are `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. Upstream describes separate agent-core and coding-agent layers. Use the former here because the application already owns its tools, prompt, and approval UI. [Source: upstream package overview](https://github.com/earendil-works/pi#packages).

## Review of the existing example

Despite the request's Anthropic Agent SDK wording, [`examples/ai-sdk`](../../examples/ai-sdk/src/agent.ts) uses **Vercel AI SDK** `ToolLoopAgent`, with `@ai-sdk/anthropic` as its default model provider. The Anthropic Agent SDK is not a dependency. Claude Code is a separate host for the same planner.

The implementation already has the right application boundaries:

- `plannerDefinition()` reads `plugin/agents/planner.md`, including the embedded skill and named Cypher queries exactly once.
- Six stdio servers come from `.mcp.json`. Fifteen tools are retained using canonical names `mcp__<server>__<tool>` from the agent's `tools:` frontmatter.
- `guardWrites()` loads fresh graph context, runs `@planner/guard.validate`, and forwards an allowed write. A refusal is visible to the model.
- The architect approves through the existing gate console. The graph, engine, ontology server, and scheduler own the deterministic work.
- The loop has a default cap of 200 AI SDK steps.

Carry these review findings into both ports:

| Priority | Evidence | Consequence and proposed treatment |
|---|---|---|
| Medium | `src/main.ts:13–15` creates the driver and awaits planner construction before entering `try` | A startup failure skips driver cleanup. Acquire resources inside a cleanup scope. |
| Medium | `src/agent.ts:96–118` closes clients sequentially; agent construction is outside the startup catch | One close failure skips later closes; construction failures can leave clients alive. Attempt every close, retain the original failure, and include construction in the scope. `main.ts:24–25` also skips driver close if planner close rejects. |
| Medium | `src/agent.ts:51–64` validates writes but emits no decision audit entry | The alternate host lacks the guard decision log required by DESIGN §3. Add local allow/deny logging with rule, canonical tool, and run correlation. |
| Low | `src/agent.ts:45–47,100–103` treats missing frontmatter as an empty allowlist | Startup can accept a malformed planner with zero tools. Require nonempty, unique, valid names and the expected write tool. |
| Low | `src/agent.ts:53` silently returns when the write tool has no executor | Presence checks alone do not establish an executable, guarded tool. Reject an unusable write binding at startup. This is a hardening gap, not a demonstrated guard bypass. |

The current tests in [`tests/examples/ai-sdk.test.ts`](../../tests/examples/ai-sdk.test.ts) cover prompt inclusion, model selection, denied/allowed writes, real MCP allowlist parity, and the cap. They do not exercise the startup/close failures above or P1–P6 through a live model. They also clear and reload Neo4j; run them only against a disposable demo database.

## Shared application boundary

Build a small `@planner/harness` workspace package for both new examples. It contains application policy and MCP plumbing, with no AI SDK, Pi, or OpenAI imports. Leave the current AI SDK example intact initially; moving it onto this package is a later, separately verified change.

```text
planner.md + .mcp.json
        |
@planner/harness: definitions, discovery, invocation, guard, audit, cleanup
        |
        +-- Pi AgentTool adapters -> Pi Agent -> selected provider
        +-- OpenAI function tools -> OpenAI Agent + Runner
        |
existing MCP subprocesses -> Neo4j / engine / scheduler / gate console
```

Suggested public application contract (pseudocode, not an SDK API):

```ts
type ToolDescriptor = {
  canonicalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
interface PlannerGateway {
  instructions: string;
  tools: readonly ToolDescriptor[];
  invoke(name: string, input: unknown, signal?: AbortSignal): Promise<ToolOutcome>;
  close(): Promise<void>;
}
// ToolOutcome retains content, structuredContent, and isError;
// host denials also carry { denied: true, reason }.
```

Only `invoke` can execute a tool. Descriptors never expose raw MCP executors. The gateway uses the already adopted `@modelcontextprotocol/sdk` client/stdio transport, declared as a direct exact dependency rather than relying on npm hoisting.

Gateway requirements:

1. Parse the planner and `.mcp.json` before launching children. Reject malformed config, duplicate names, empty allowlists, unknown server references, and missing write bindings. Freeze the discovered descriptors for the run; do not dynamically expand the allowlist.
2. Launch the six configured servers with `cwd = root`. Preserve commands/arguments as argv, without a shell. Use string-valued environment entries with precedence `process.env < entry.env < caller overrides`. Retain stderr for diagnostics outside the model transcript. Fail startup if any required tool is missing.
   Resolve Neo4j configuration once before constructing the guard driver or launching graph-using children. The guard, read/write servers, gate, ontology, scheduler, and separate console must target the same graph. Reject conflicting graph-related server/caller overrides, including standard and Neo4j MCP-specific URI/credential settings; do not apply ordinary environment precedence to graph identity. Until database selection is explicitly supported end to end, retain the existing single default database and reject custom database overrides. Otherwise a guard could validate an approved gate or active ontology term in graph A before the writer mutates graph B. The separately running console is covered by the managed launch protocol below; matching child environment settings alone is insufficient.
3. Validate input against the discovered schema locally. For `write-cypher`, require a string query and object params; load context for the string-valued `params.deal`, then call `validate` immediately before forwarding the unchanged arguments. Schema errors and policy denials return actionable model feedback. A context/guard infrastructure failure stops the run and never invokes the server.
4. Log allow and deny decisions locally, following `GUARD_LOG` and `.logs/guard.jsonl`, with time, host, run ID, canonical name, deal, rules, and reason. Keep full params and secrets out of the default log. Report log-write failures explicitly, consistent with the existing hook's best-effort audit behavior.
5. Serialize gateway invocations per run, including guard validation and forwarding. This prevents overlapping graph mutations and polls. Recheck cancellation after acquiring the queue. Serialization does not make frame/select gates mechanically enforced; those remain skill instructions, while commit is checked by G8. This preserves the existing contract's limitations.
6. Preserve MCP `isError`, text, `structuredContent`, and witnesses. Do not turn a failed tool response into an empty success. Format text or structured JSON for the model without dropping the error marker. Reject unsupported content explicitly rather than silently losing it.
7. Use explicit 60,000 ms MCP call deadlines. Default gate polls take 50 seconds, with `GATE_WAIT_SECONDS` restricted by the existing server to 1–55. Pending is a valid response: retain the same `gate_id` and let the skill call `await_approval`. Include ontology proposals, which also wait for approval. Do not blindly retry timed-out state-changing calls; enter the operator recovery procedure below before another model run.
8. Own all successfully created clients/transports immediately. On connection, discovery, model-construction, run, or cancellation failures, attempt every cleanup with `Promise.allSettled`. Make close idempotent; preserve the primary error and report secondary cleanup failures. The CLI separately owns and always closes the Neo4j driver after gateway cleanup attempts.

The lexical guard remains defense in depth, and its context check plus remote write is not one transaction. These ports do not claim to remove that existing race or add database isolation.

## Managed console launch and graph identity

Both new example commands enter one shared launcher before creating a model or MCP clients. The launcher owns the separate console process as well as the host run; the new examples cannot attach to an independently started `npm run demo:ui` console. Existing Claude Code/AI SDK entry points retain their existing standalone mode.

1. Resolve the selected deal from an explicit `--deal` option (default `nimbus`), console port, and one Neo4j configuration. Require exclusive use of this disposable demo graph during the run/recovery: no other planner host or reset process may operate concurrently. This is an operating prerequisite, not a new distributed-lock guarantee.
2. Build the UI, then fork `packages/gate/bin/console.ts` over an IPC channel with the exact resolved Neo4j configuration and a fresh per-launch token. In managed mode the console accepts graph settings only from that launch configuration; inherited or per-process overrides cannot replace them. Its ready message includes the token and bound address, without credentials, and is sent only after its Neo4j connection succeeds and its HTTP listener binds.
3. The launcher waits for that child's readiness, with a bounded timeout. **Any occupied port is fatal, even if an existing console appears healthy or has matching settings.** Do not accept an HTTP health response as proof of ownership; do not reuse an old console or silently select another port. Close the new child/driver and report the requested address. The operator can stop the old console or explicitly select a free port and retry.
4. Only then create the host driver and MCP clients from the same resolved configuration. Force `GATE_HTTP=off` in the gate child and reject conflicting overrides, including managed launch attempts to enable its HTTP server. Managed `gate-mcp.ts` must reject missing/inconsistent launch settings rather than taking the legacy `EADDRINUSE` continuation path. `GATE_HTTP=off` does not weaken MCP gate behavior; decisions continue through the owned console and shared graph.
5. The launcher monitors console exit/IPC loss and latches a fatal run error, aborting the host and queued work. Cleanup attempts both the console and every MCP child. An in-flight mutation can still commit and is handled by restart reconciliation. Never log the full launch configuration or database credentials.

This establishes console configuration/ownership through a child process, rather than comparing URIs with an unrelated server on the same port. Console managed mode, readiness/error IPC, gate managed-mode validation, and launcher failure handling are implementation work in scope for **both** ports. No new public identity endpoint, ontology label, agent tool, or gate approval route is required. A future attach-to-existing-console mode would need a separate graph-identity handshake and is excluded from this MVP.

## Restart reconciliation and operator recovery

The MVP deliberately supports **fresh graph runs plus operator reset**, not automatic mid-plan resumption. `recall_memory` returns feedback/overrides but omits pending gates; `next_iteration` allocates a new iteration. Neither is a recovery mechanism, and the unchanged skill must never be asked to infer a lost gate ID.

Before starting a provider request or exposing model tools, the launcher runs a host-only, read-only reconciliation pass for the selected deal using the same graph configuration. Query `Iteration`, `Roadmap`, `GateDecision` (all statuses, with IDs, gate kind, iteration, summary, and subject refs), deal-scoped proposed/active ontology terms, and open Feedback/active Overrides. Use `GateStore.listGates(undefined, deal)` for the gate view; recovery reads are application code, not extra model-facing MCP tools.

Bind that selected deal immutably to the gateway for the entire run and identify it in the prompt. Every supplied top-level `deal` or Cypher `params.deal` must match it; require `params.deal` for writer calls. Resolve `gate_id`-only calls through a trusted graph read and require the gate's `deal_code` to match before invoking `await_approval`. Apply the same binding to ontology proposals, scheduler calls, and feedback resolution. Refuse mismatches before any downstream invocation, without silently switching deals. Pure unscoped engine tools/schema discovery do not select another deal. Thus checking clean Nimbus cannot authorize a later request for a different deal whose interrupted state was never checked. This input binding does not strengthen the lexical guard into a proof of arbitrary Cypher isolation.

The MVP permits a fresh run only when **both** conditions pass: (a) that deal has no iterations, roadmaps, gates, deal-scoped ontology terms, open feedback, or active overrides; and (b) the positive dataset-readiness verification below succeeds. Absence of planning state is never evidence that loading completed. Seeded completed history deals remain part of the expected dataset and do not count as interrupted planning for the selected deal. Any existing target plan state, including an apparently committed roadmap, exits nonzero with `RECOVERY_REQUIRED`; missing/incomplete/invalid data exits with `DATASET_NOT_READY`. Either error occurs before a model request or mutation. This intentionally disallows starting another CLI planning session on an already planned deal; feedback-driven re-planning within the same running conversation still follows the unchanged skill. Supporting subsequent runs without reset requires a separately designed resume/new-run protocol.

The recovery command must still be able to inspect and report state when no planner transcript or local journal survives. A lost gate result is recovered by reading graph IDs, never by recomputing the deterministic ID or issuing another `request_approval`. Multiple candidate gates are reported together; no unique match is assumed. Print statuses from the graph even if the architect already approved/rejected the gate after the interruption.

### Positive dataset readiness and retained global terms

Add a shared **read-only** `verifyLoadedDataset` verifier under `graph/load/verify.ts`, used by loader completion, reset completion, and every fresh-process startup. Startup must not call `loadAll` or repair missing data implicitly. Derive expectations from `readDataset`, `validateDataset`, `config/ontology.json`, and the checked-in `data/manifest.json`; reject invalid files or a manifest inconsistent with the dataset before using them as the oracle.

- Require the selected deal to exist exactly once in both the configured fixture dataset and graph. Compare fixture node identities using ontology keys, relationship identities using type and keyed endpoints, and fixture property values/types after the same integer/datetime normalization used by loading. In particular, require the selected deal's complete expected Finding/Source sets and `HAS_FINDING`/`SUPPORTED_BY` links, plus catalog and history content. Exact baseline node/relationship counts must also match the manifest. Zero rows, missing findings or edges, wrong keys with identical counts, partial catalog/history, and unreadable verification results all fail; a bare `RETURN 1` or empty planning set is insufficient.
- Require core uniqueness constraints and approved retained-label constraints to exist; readiness is a read, not schema application. Extra idempotent constraints left by removed scoped terms may remain. The graph must contain the fixture baseline plus only the explicitly permitted retained nodes below; unexpected residual nodes/edges are errors.
- Keep `graphCounts()` reporting the **physical whole graph**, and keep the default `loadAll` verification mode **strict**, including its current exact-manifest tests. Add an explicit `retain-active-global-terms` verification mode to loader/CLI completion. Reset selects that mode deliberately; startup selects the same mode for a read-only readiness check. Do not globally ignore `OntologyTerm`, increase manifest expectations to whatever the graph contains, or regenerate the fixture manifest to accept runtime state.
- In retained mode, separately classify/validate each extra node: it must have exactly the `OntologyTerm` label, `scope: 'global'`, `status: 'active'`, no `deal_code`, a unique `(kind, name)` key, all required property types from the ontology, a valid non-core label/type name, and the uniqueness constraint required for an approved label term. Proposed/rejected/scoped/malformed terms, duplicate keys, unexpected labels, or other extra nodes are not exempt. After reset, no edges incident to retained terms are expected: their `MOTIVATED_BY`, `APPROVED_BY`, and incoming gate links disappear when the per-deal findings/gates are deleted. Unexpected surviving term edges fail verification; do not broadly subtract relationship types from the counts.
- Compare the **baseline projection** (all graph nodes except those validated retained terms, and all remaining relationships) to the unchanged manifest and keyed fixture data. Report baseline verification and the separate retained-term count/keys explicitly; returned physical counts may legitimately include `OntologyTerm: 1`. The loader must not print that those physical totals equal the fixture manifest. A normal fresh load with no retained terms still has exactly the original manifest counts.
- Before reset deletion, validate global-term metadata and snapshot their keys/properties; existing legitimate provenance links are allowed at this pre-reset stage. After reload, require that snapshot to be unchanged, validate retained terms/constraints again, and verify the baseline projection. Do not delete promoted terms, re-scope them, synthesize replacement approvals, or require their deleted per-deal provenance links to reappear. Explain that demo reset retains the term metadata/DDL while deleting its per-deal approval/evidence history. A new startup without a reset snapshot validates the current retained terms structurally; it cannot attest their historical provenance.

Positive verification is recomputed from graph contents on every startup, independently of the previous process's exit code or local logs. A reset that deletes data then fails during reload remains `DATASET_NOT_READY` in a new process with zero provider calls. A previous success message cannot authorize a graph that is now incomplete. If data is already fully present and verifies after a process interruption, the readiness predicate is satisfied; this is validation of current data, not automatic continuation of an interrupted plan. Target planning-state checks still apply separately.

Operator procedure (new commands below are proposed implementation deliverables):

1. Stop the interrupted host and other graph writers. Run `npm run planner:recover -- inspect --deal nimbus` with the same Neo4j configuration. It performs only the reconciliation reads and lists every existing gate ID/status, iteration, roadmap, and ontology state, plus the reset scope. It does not start a model, poll/create gates, approve anything, or advance the iteration.
2. Preserve any wanted decisions/report through the existing console/export workflow. If preserving the interrupted plan is required, leave the run blocked; automatic continuation is unsupported. Approving a pending gate does not by itself make a fresh run safe or clear the block.
3. To restart the disposable demo, explicitly invoke `npm run planner:recover -- reset --deal nimbus --confirm-reset-demo`. This command requires the confirmation flag, no active managed run/console, and a fresh identity/configuration check. It wraps the existing `scripts/reset-demo.sh` and then repeats the read-only reconciliation **and positive dataset verification**. The script uses `docker compose exec` with the `neo4j` user, so reset is supported only for this repository's Compose Neo4j service and that default user: verify the selected URI/port and password match that service's published endpoint/configuration, and pass the same resolved settings to the loader. Refuse remote targets, custom usernames/databases, mismatched ports/configuration, or an unverifiable Compose target before deletion; never reset a local graph while inspecting a different graph. Update the script itself with a pre-deletion target check and retained-term snapshot, then invoke the loader's explicit `retain-active-global-terms` mode so it cannot delete A while loading B or fail solely on a valid retained term. **The script resets all per-deal subgraphs and reloads deals/history, not only Nimbus**; `--deal` selects the readiness check, not a narrower deletion scope. Explain that scope before accepting the flag. Catalog/global terms are retained; this is demo reset, not rollback or archival recovery. Never invoke reset automatically on startup, timeout, or cancellation.
4. Only after reset/reload verification succeeds and the selected deal passes both the clean-state and positive dataset-readiness checks may the operator rerun the ordinary example command. An incomplete reset/reload remains blocked in a fresh process; missing or unverifiable data never passes merely because the planning nodes were deleted. No direct edits to reserved labels, fabricated feedback, or synthetic rejection is used to unblock a run.

For a response lost after a non-gate mutation, the same conservative block applies whenever planning state exists. If a failure happened before any persistent planning change, retry still requires positive dataset readiness. Tests must inject interruption **after** `GateStore.requestGate` commits but **before** the MCP result reaches the host, including the ontology-proposal gate path: one gate exists, restart reports its exact ID, zero model calls/mutations occur, and no duplicate gate or next iteration appears. Cover already decided gates, multiple pending gates, missing local history, the reset failure path, and clean restart after an explicit successful demo reset.

## Pi runtime adapter

Use `Agent` with `initialState.systemPrompt`, the resolved model, and a list of `AgentTool` wrappers. Each wrapper copies the canonical name, description, and discovered JSON Schema and delegates execution exclusively to `gateway.invoke`. Return model-visible content plus structured details; use `afterToolCall` to preserve `isError` for denials and MCP errors without losing their witnesses. Unexpected infrastructure failures must latch a host failure and abort the agent before surfacing the tool error, because Pi catches ordinary tool exceptions and can continue the loop. Configure `toolExecution: "sequential"`; Pi currently defaults to parallel execution. [Source: agent-core API and tool documentation](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md), [tool hook types](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts).

The provider layer uses `createModels()`, explicit provider factories, model lookup, and a bound `streamSimple`. Resolve `PLANNER_MODEL=anthropic:<id>` first to compare harness behavior with the existing example on the same model. Add `openai:<id>` as the second documented provider. Reject an unknown provider, missing credential, missing model, or a model without tool support before MCP startup. Preserve `ANTHROPIC_BASE_URL` through explicit provider configuration; generic OpenAI-compatible endpoints are a later compatibility test, not assumed equivalent. [Source: Pi provider and auth documentation](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md).

Implement a host-owned request budget around `streamFn`: before each provider request, stop when the configured positive integer `maxSteps` (default 200) is exhausted. Count model requests, not tool events, and label that metric in output. Do not invent a Pi `maxTurns` option or rely on a post-turn listener as the only bound. The stream wrapper must produce the error/aborted terminal event expected by Pi, without calling the provider again. Pi's `StreamFn` contract specifies failure events and a terminal assistant message. [Source: runtime types](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts).

Subscribe to text and tool events for terminal progress. Keep canonical names in logs. `SIGINT` aborts the agent and propagates cancellation to MCP calls; queued invocations must not execute afterward. After `prompt()` settles, inspect terminal error/abort state before reporting success. Emit a nonzero exit for failure or cap exhaustion, even if partial assistant text exists. [Source: agent lifecycle implementation](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts).

**Provider resilience (approved implementation extension).** Use the SDK's native HTTP
`maxRetries: 2`/`maxRetryDelayMs: 60000` and exported `retryAssistantCall`/`isRetryableAssistantError`
for interrupted responses. A guarded fetch boundary shares four attempts per model turn across
both layers and counts native retries against the run budget. Honor the final HTTP Retry-After
across assistant retries too; do not shorten a server wait through an outer retry. Quota/billing,
authentication/invalid requests, provider retry refusal, cancellation, and delays over the cap
are terminal. Three consecutive transient failures open a run-local circuit for 30 seconds (or a
longer permitted provider delay), then allow one probe. Failure stops; a completed response closes
the circuit. Consume provider responses before delivering text/tool calls to the agent, discarding
failed partial content. Retain completed tool results in the same conversation and never retry MCP
calls or the whole planner. Log provider/model, attempt counts, retry waits and circuit states,
without payloads or credentials. Retry and circuit waits must obey cancellation.

Start with in-memory conversation state and one CLI prompt per run. Neo4j remains the durable planning record, but restart enters the reconciliation/operator procedure above before any model request. It does not resume by running the skill from step 1 against a partial plan. Session persistence, compaction, interactive TUI, and CLI extensions are separate work. The higher-level coding SDK discovers resources/settings and has persistent sessions by default, so adopting it would also require controlling ambient tools and resource loading. [Source: coding SDK lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

## Files and delivery sequence

| Proposed path | Responsibility |
|---|---|
| `packages/harness/src/{definition,gateway,audit,types}.ts` | Shared contracts above |
| `packages/harness/src/{launch,recovery}.ts`, `scripts/planner-recover.ts` | Owned console launch/IPC, startup reconciliation, inspect and explicit demo reset |
| `scripts/reset-demo.sh` | Verify Compose target before deletion, snapshot retained terms, select explicit loader verification mode, and require dataset readiness |
| `graph/load/{index,verify}.ts` | Shared read-only keyed dataset/readiness verification; strict default plus explicit retained-global-term mode and accurate reports |
| `tests/graph/load.test.ts`, `tests/examples/recovery.test.ts` | Strict-loader regressions, failed reload/new-process startup, valid promoted-term reset, invalid retained extras |
| `packages/gate/bin/{console,gate-mcp}.ts`, `graph/connection.ts` | Shared connection config, managed console readiness and occupied-port refusal, managed gate validation |
| `packages/harness/test/*.test.ts` | Failure, allowlist, schema, guard, timeout, cancellation, cleanup cases |
| `tests/gate/console.test.ts`, `tests/examples/recovery.test.ts` | Console-A/host-B refusal and post-commit/pre-response interruption recovery |
| `examples/pi/{package.json,README.md}` | Exact dependencies and run instructions |
| `examples/pi/src/{agent,model,main}.ts` | Pi wrappers, provider config, bounded loop, CLI resource ownership |
| `tests/examples/pi.test.ts` | Fake provider plus real disposable MCP integration |
| root `package.json`, `package-lock.json`, `README.md`, `docs/design/DESIGN.md` | `example:pi`, `planner:recover`, managed launch/recovery contract and run instructions |

1. After design approval, update DESIGN §§1.4/4/6/7, write gateway, managed-console, loader/readiness, and recovery behavior tests, then implement the shared boundary and verify canonical tool parity against the skill/frontmatter. Have the repository's `spec-reviewer` review guard/gate enforcement changes. The console, loader verification, and recovery work are prerequisites to either adapter, not optional follow-up work.
2. Pin compatible published Pi packages together. Current upstream manifests show `1.5.0`; this is a research snapshot, not verified npm availability. Confirm the chosen release exports the APIs above, install exact versions, and commit the lockfile. Do not mix legacy `@mariozechner/*` examples with the current namespace. [Source: agent-core manifest](https://github.com/earendil-works/pi/blob/main/packages/agent/package.json), [provider manifest](https://github.com/earendil-works/pi/blob/main/packages/ai/package.json).
3. Implement the adapter and scripted fake-provider cases; then exercise real MCP tools on a disposable database.
4. Rehearse Nimbus with the architect console using the same Claude model as the baseline, then the selected OpenAI model. Record model/package versions and actual P1–P6 results; keep untested providers explicitly experimental.

Proposed invocation after implementation:

```bash
PLANNER_MODEL=anthropic:<model-id> npm run example:pi -- --deal nimbus "Plan the Nimbus integration."
```

The example command owns and opens its console; do not start `demo:ui` separately for this managed mode. Credentials come from the selected provider's environment. The angle-bracket model value is a placeholder, not a runnable model ID. Do not change the baseline model silently if unavailable; report it and select an explicit comparison model.

## Acceptance

- Exact prompt inclusion once; exact 15-tool canonical allowlist; no shell, file-writing, code execution, codemode, or additional ambient tools registered.
- Denied write invokes the MCP writer zero times; allowed template invokes it once; graph-context failure forwards nothing. G8 denies missing, rejected, wrong-deal, and wrong-iteration commit gates. A newly approved ontology term is visible to the next write.
- Inject malformed definitions, missing tools, schema errors, partial connection failure, model-construction failure, and one rejecting close. All acquired resources still receive cleanup attempts.
- A child configured for Neo4j B while the guard is configured for A is rejected before startup. Verify all graph-using processes receive the same resolved connection settings; do not claim G6/G8 protection across different graphs.
- Start a standalone console on graph A at the requested port, then launch a host configured for graph B: startup fails before any provider call or MCP mutation, does not reuse A's console, and cleans up its own resources. Repeat for an old console on the same graph: still refuse. Verify managed console readiness token/config validation, readiness timeout, post-ready console exit, and rejected `GATE_HTTP=on` overrides.
- Interrupt a normal gate request and an ontology proposal after gate creation commits but before response delivery. A new process with no local history reports the original gate IDs and `RECOVERY_REQUIRED`, with zero provider requests, duplicate gates, or new iterations. Decided/multiple gates still block. Inspect is read-only; reset requires the explicit flag and restores readiness only after reload and reconciliation pass.
- Inject reload failure after per-deal deletion, then start a **new process** with no local reset history: `DATASET_NOT_READY`, nonzero exit, and zero model calls/tool mutations. Repeat with an empty graph, missing selected Deal, missing Finding/Source/edge, partially loaded history, and wrong keyed nodes with identical counts. An earlier successful load/check must not mask subsequent missing data. A successful complete reload passes the same read-only verifier.
- Promote a real term through `ontology_term` and `ontology_promote` approvals, then explicitly reset. Preserve its exact global active metadata and label constraint; delete the per-deal provenance with the reset, load/verify baseline counts unchanged, report the retained term separately, and permit fresh-process startup. Repeat reset successfully (idempotence). Default strict loading must still reject an extra term; retained mode must reject proposed/rejected/scoped/malformed/multilabeled extras or unexpected term edges, and must still detect a missing baseline node. No live model is needed for these tests.
- Reset refuses a remote or differently forwarded Neo4j target before deletion; the Compose reset target, loader, and reconciliation reader must all agree. Document and verify its all-deals reset scope.
- Check clean Nimbus, then inject top-level `deal`, writer `params.deal`, scheduler/ontology/feedback calls, and a gate-only wait targeting a different deal with an existing pending gate: reject every mismatch before downstream execution, with no duplicate gate, new iteration, or graph mutation.
- Pending then approved/rejected gates, including ontology proposals, retain gate identity; 50-second waits fit the explicit deadline; aborted queued writes never execute. A lost write response is not automatically retried.
- With a fake provider that requests tools forever and `maxSteps=3`, at most three provider requests occur. Exhaustion produces an incomplete result and nonzero CLI exit.
- Run the existing deterministic skill walks on a disposable database, then demonstrate P1 prerequisite derivation, P2 conflict repair, P3 ontology approval, P4 feedback-driven iteration, P5 cycle repair, and P6 buy/build outcomes through the new host. Validator verdicts and graph decisions are the oracle; narrative wording need not match. Target the data contract's five successful rehearsals before calling a provider supported.
- Automated tests use fake providers and deterministic fixtures; live-model rehearsals stay outside `npm test`. Before declaring implementation complete, follow the full [`/verify` workflow](../../.claude/commands/verify.md), including lint, typecheck, tests, and denylist reporting, plus focused gateway/Pi tests and `npm run check:tools` with the demo services available. This document defines future implementation acceptance; passing baseline repository checks does not demonstrate the proposed host's behavior.
