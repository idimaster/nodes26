# Initial implementation verification

Verified with Node **24.21.0**, npm **11.19.0**, `@openai/agents` **0.21.0**, and the OpenAI client
**7.19.0**. Automated tests use a disposable local Compose graph, scripted SDK models and a fake
Responses HTTP transport; no live model is called. The shared harness pins Ajv **8.20.0** and
ajv-formats **3.0.1**, validates schemas at discovery and preserves input values without coercion.

| Check | Result |
|---|---|
| Neo4j Compose service | Pass: healthy |
| `npm run lint` | Pass after correcting the scripted-model helper's unused generator |
| `npm run typecheck` | Pass |
| `npm test` | Pass: 79 files, 746 tests, including existing deterministic P1–P6 walks |
| Focused SDK/MCP and CLI tests | Pass: `openai-agents.test.ts`, `openai-agents-cli.test.ts`, `openai-agents-integration.test.ts` |
| `npm run check:tools` | Pass: canonical allowlist, served tools, skill references and guard coverage agree |
| CLI help / invalid turn limit | Pass: help exits 0; `--max-turns 0` exits 1 before launch |
| `git diff --check` | Pass |
| `npm run denylist` | **Skipped**: `DENYLIST_FILE` unset; command exits 2 and reports check not run |
| Independent read-only spec review | Pass; no unresolved implementation findings |
| Live OpenAI P1–P6 rehearsals | **Not run**: no `OPENAI_API_KEY` configured |

The initial focused integration test used an incorrect template name; it was corrected to the real
`create_iteration` template with its required timestamp. Focused and full suites then passed.
CLI/tool checks ran outside the execution sandbox because tsx requires a local IPC socket.
The working tree was initially clean; all final modifications/untracked files belong to this task.

| Design acceptance area | Status and evidence |
|---|---|
| Prompt and exposure | Met: one embedded skill, all 15 canonical tools, bijective maps, no handoffs/direct MCP/ambient tools |
| Serialized SDK request | Met: actual OpenAI client HTTP body inspected with fake fetch; mapped names match instructions, `strict: false`, schema equality, nested arbitrary params preserved; collisions, oversized names and undeclared prompt references rejected |
| Guard | Met: real malformed/destructive calls refused and valid template forwarded; shared G8 status/deal/iteration and fresh ontology tests; allow/deny audit tests for both host names |
| Graph identity | Met through shared configuration/launch tests: guard and children share resolved settings; environment/CLI/database conflicts refused |
| Console identity | Met through shared launch/console/Pi integration tests: owned IPC readiness, occupied-port refusal, timeout/token/exit failures and gate HTTP override rejection |
| Gate behavior | Covered: pending ID and structured witnesses visible through SDK; real architect HTTP approvals and rejection-driven second iteration match recorded roadmap; ontology refresh and MCP deadlines covered by shared tests |
| Restart recovery | Covered by shared recovery tests: graph-derived gate/plan state, decided/multiple gates, read-only inspection, blocked fresh starts and operator reset; exhaustive interruption after commit/before transport response remains untested |
| Recovery scope | Met through shared tests: selected-deal binding, trusted gate lookup and verified Compose-only all-deals reset; CLI failure guidance retains selected deal |
| Failed reload | Met through shared readiness/reset tests: missing/changed fixture content, edges, keys, history and constraints block a new process |
| Retained promotion | Met through existing real ontology promotion/reset tests: two resets preserve active global metadata/constraints, baseline remains strict, invalid retained terms rejected |
| Loop safety | Met: endless real Runner loop makes three model calls at `maxTurns=3`; CLI rejects, entry point maps rejection to nonzero; active/pre-request cancellation tested; aborted queue covered by gateway tests |
| Lifecycle | Met: shared startup/discovery/close failures unwind every acquired resource; CLI covers provider construction/inspection errors and provider close; launch-owned read-only inspection remains available after abort |
| Graph parity | Met for scripted SDK Nimbus and feedback recordings with real MCP/console and exact graph snapshots; existing deterministic P1–P6 walks pass. **Live-host parity not established** |
| Release evidence | **Not met for supported-provider claims**: five successful live runs of a named model configuration and P1–P6 rehearsals remain pending |

This example is runnable with explicit model/credentials and remains experimental. Automated
adapter correctness does not establish live planning quality or complete provider-support acceptance.

## Connection-error diagnostics follow-up

A live `openai:gpt-6-luna` run stopped after 21 model requests with the generic `Connection error.`
Read-only inspection confirmed the ontology/frame approvals and draft iteration remain, with no
committed roadmap. The original failure's underlying transport cause was discarded, so its exact
network cause cannot be established retroactively. This is an interrupted rehearsal, not a pass.

Error reporting now retains bounded error-class/transport-code details through nested causes and
AggregateErrors; nested messages, URLs, headers and credentials are omitted. Retries, recovery and
graph behavior are unchanged. Tests first reproduced lost cause codes, then passed with the fix.

| Follow-up check | Result |
|---|---|
| Compose service health | Pass: healthy |
| Lint / typecheck | Pass under Node 24.21.0 |
| SDK and CLI unit tests | Pass: 2 files, 16 tests; nested/cyclic/aggregate causes and credential omission covered |
| Full graph/integration suite | **Skipped** to preserve the interrupted live run and its approvals; these tests wipe/reload demo data |
| Denylist | **Skipped**: `DENYLIST_FILE` unset |
| `git diff --check` | Pass |
| Interrupted live run | Preserved; no reset, replay or new model request performed |

## SDK retries and circuit follow-up

The approved reliability change uses Agents SDK `modelSettings.retry`/`retryPolicies` with one retry
owner. The CLI explicitly disables native HTTP retries. The SDK handles jitter/backoff, Retry-After
parsing and abortable delays; a small adapter state machine adds the run-local circuit. Tests first
reproduced the missing HTTP/2, throttling and circuit behavior, then passed with the implementation.

| Check | Result |
|---|---|
| Node / npm | 24.21.0 / 11.19.0 |
| Isolated Compose service | Healthy, fixtures verified on Bolt 27687 / HTTP 27474 |
| `npm run lint` / `npm run typecheck` | Pass |
| Focused SDK/CLI/reliability tests | Pass: 3 files, 45 tests (28 reliability cases) |
| `npm test` | Pass: 81 files, 798 tests in the current working tree, including pre-existing Pi reliability work |
| `npm run check:tools` | Pass: served tools, skill references, canonical allowlist and guard coverage agree |
| CLI `--help` | Pass |
| `git diff --check` | Pass |
| `npm run denylist` | **Skipped**: `DENYLIST_FILE` unset; command exits 2 and reports check not run |
| Independent read-only spec review | Pass; no unresolved findings |
| Live model rehearsal | Not run; no provider request made during verification |

Full graph tests used a separate Compose project, `planner-openai-retry-check`, with its own container
and volumes. Read-only database ID comparisons confirmed that direct/routed connections on 27687
reached that isolated database and that the demo on 7687 remained a distinct database. The original
demo graph was not reset or replayed. Temporary verification resources were removed afterward.
Pre-existing Pi files, the launch-test environment fix and the Pi block in DESIGN were preserved;
this change adds the OpenAI-specific implementation, tests and contract.

| Approved behavior | Status and evidence |
|---|---|
| SDK retry owner and attempt limits | Met: Runner retry configuration, CLI client `maxRetries: 0`, real fake-HTTP transport attempts and existing turn-cap tests |
| HTTP/2/network recovery | Met: direct/nested `ERR_HTTP2_INVALID_SESSION` and real SDK response-body failure recover within the same turn |
| Throttling/backoff | Met: real SDK HTTP 429/503, SDK numeric/date/millisecond Retry-After parsing, default backoff, long-delay refusal and 60-second circuit delay |
| Circuit breaker | Met: three failures open the circuit, no calls during cooldown, one probe, success closes/reset count and failure stops after four attempts |
| Terminal failures and replay vetoes | Met: auth/invalid requests, quota/billing, TLS errors, server/provider vetoes, unsafe replay and response-start evidence are excluded |
| Cancellation | Met: cancellation during SDK backoff and circuit cooldown makes zero further model attempts; existing active/pre-request cancellation tests remain green |
| Tool and conversation preservation | Met: prior gate/tool results remain identical across model retries, tool invocation stays single, uncertain MCP failure is never retried; existing real graph recordings pass |
| Diagnostics and cleanup | Met: CLI model/attempt/retry/circuit events, bounded cause codes, provider cleanup, graph-state reporting and incomplete/nonzero behavior |

Retries make transient failures recoverable; persistent failures still stop incomplete with the saved
graph intact. Automatic restart/persisted resume and live-provider support acceptance remain pending.

## Optional tracing verification

`--trace` enables a single redacting SDK batch exporter; the default still exports no traces.
Metadata records the actual Node/undici runtime, selected model/deal and guard-run correlation.
SDK spans and custom attempt/tool/gate/retry/circuit spans omit request/output payloads and raw
exception messages. Exporter attempt-count semantics and SDK signal-handler shutdown races were
found during independent review, reproduced with tests and corrected.

| Check | Result |
|---|---|
| Node 26.8.2 focused SDK/tracing tests | Pass: 4 files, 61 tests, including real subprocess SIGINT/SIGTERM and actual exporter POST with fake HTTP |
| Focused tracing/harness TypeScript check | Pass under pinned Node 24.21.0 |
| Full workspace lint/typecheck | Pass on final checks; earlier tracing type error fixed, concurrent AI SDK provider mismatch no longer present |
| CLI help | Pass: documents `--trace` and OpenAI export destination |
| Independent spec review | Pass after exporter-attempt and signal-lifecycle fixes |
| Full graph suite | **Incomplete/failed**: isolated recovery/recorded-walk failures followed by 60-second graph-hook timeouts; remaining run interrupted |
| Graph diagnostics | Isolated Neo4j reported `Failed to transmit operation result: Response write failure`; cause of graph-run failures not established |
| Focused recovery rerun | Fail: `Connection acquisition timed out in 60000 ms` (zero active/idle connections), plus hook timeout |
| Tool-surface check | Fail: `MCP error -32000: Connection closed` |
| Denylist | **Skipped**: `DENYLIST_FILE` unset |
| Live model/dashboard export | Not run; tests use fake model/HTTP and in-memory trace capture |

Acceptance evidence: default-off behavior, payload/error redaction at actual ingest boundary,
canonical gate spans, runtime/request-ID/run correlation, retry/circuit interval closure on cancellation,
five-second shutdown bound, failure isolation without repeated callbacks, and final span export after
real SDK SIGINT/SIGTERM all pass. Graph verification used the separate Compose project on 27687;
the demo on 7687 was not reset. Existing Pi/AI SDK work and dependency edits were preserved.
Tracing adds observability; it does not establish that the original live connection failure is repaired.
