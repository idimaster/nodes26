# Design specification: local diagnostics for the OpenAI Agents planner

Status: **partially implemented**. Created 2026-11-04. The OpenAI host now writes local metadata
files, uses a local SDK processor, and has removed the remote trace exporter. Gateway/graph
observations, semantic triage, and several acceptance cases below remain pending.

Related contracts: [local Pi diagnostics](LOCAL-DIAGNOSTICS.md),
[diagnostics v1 schema](diagnostics-v1.schema.json), [OpenAI Agents host](OPENAI-AGENTS-SDK.md),
and [planner implementation contract](DESIGN.md). The shared `@planner/diagnostics` package already
has a synchronous per-run writer, schema validation, bounded error projection, and a basic offline
reader. The Pi CLI uses that package. The Pi specification's SDK telemetry adapter, complete
gateway/graph observation, triage report, and terminal renderer are not yet implemented; this
proposal does not treat them as available dependencies.

## 1. Outcome and scope

One local file must let an operator identify the failing agent turn, physical OpenAI request,
retry decision, tool dispatch, and observed graph state without a tracing account, dashboard, or
trace-ingest request. The local reader must distinguish facts from missing evidence. Diagnostics
cannot change a model request, repeat a tool call, alter a guard verdict, or replace the primary
planner error.

The first implementation covers the current **nonstreaming Responses** model path in
`examples/openai-agents`. Streaming, sessions, handoffs, hosted tools, distributed traces,
content capture, uploads, and remote export are outside this version. Keep the existing
single-run/managed-harness behavior and retry policy.

## 2. Decisions

1. Replace `--trace` with `--diagnostics metadata|off`. Precedence is CLI argument,
   `PLANNER_DIAGNOSTICS`, then `metadata`, matching the Pi CLI. Print the relative file path
   once on stderr. `off` creates no file and no SDK spans.
2. Use `@planner/diagnostics` for capture, projection, and reading. Extend its public API with
   a host discriminant and typed observation methods rather than making the OpenAI example
   construct arbitrary schema payloads. Do not add Pi telemetry as an OpenAI dependency.
3. When metadata capture is enabled, replace the SDK's default trace processors with **one
   local processor** before constructing the Runner. Do not add a batch processor or
   `OpenAITracingExporter`. Set `traceIncludeSensitiveData: false` and project each SDK span
   through a per-span allowlist before writing. This flag alone is insufficient because SDK
   errors and custom data can still contain free-form content. When capture is off, replace
   processors with an empty list and set `Runner.tracingDisabled: true`.
4. Respect `OPENAI_AGENTS_DISABLE_TRACING`. If it is set while metadata capture is requested,
   capture host, HTTP, retry, MCP, and graph observations, mark SDK-span coverage unavailable,
   and never re-enable global SDK tracing. This is not a CLI conflict: local capture can still
   produce useful evidence.
5. Keep the SDK's trace context and span lifecycle for SDK-owned agent, turn, generation,
   response, and function spans. Add application spans only for operations the SDK does not
   represent: planner run, physical provider attempt, retry/circuit wait, MCP dispatch, and
   graph observation. SDK function spans describe agent execution; gateway events establish
   guard and dispatch facts.

The SDK documents `setTraceProcessors()` as replacing its default export processors, and
`traceIncludeSensitiveData` as excluding model/tool inputs and outputs from spans. The local
processor is an application decision based on those contracts, not a claim that the SDK supplies
an offline diagnostics format. [Official OpenAI observability guidance](https://developers.openai.com/api/docs/guides/agents/integrations-observability).
Validate callback timing, signal shutdown, and span shapes against the pinned `@openai/agents`
0.21.0 package during implementation. SDK callback exceptions must be contained by the
diagnostics adapter; SDK operations must keep their original result/error identity.

## 3. Identity and record contract

The existing diagnostics v1 file is a **live Pi format**. Extend it additively so existing Pi
files continue to validate and read without migration. If implementation discovers a semantic
change that cannot be additive, introduce v2 and retain a v1 reader. Required additive changes:

| Contract area | Change |
|---|---|
| Host | Admit `openai-agents` alongside `pi`; validate host and event combinations. |
| Start metadata | Record pinned Agents SDK, OpenAI client, Node, undici, and writer versions; mark unavailable values null. Keep Pi version fields valid for old files. |
| Span names | Admit an `openai.agents.*` namespace with a fixed name map; never serialize arbitrary SDK names, tool descriptions, or custom attributes. |
| Error source | Admit an `agents_model` source for errors raised after the HTTP boundary. Preserve `fetch`, `http_body`, and `host` sources. |
| Capability | Record whether SDK spans, HTTP observations, gateway events, and graph snapshot are available. Absence cannot be interpreted as success. |
| Response evidence | Represent parsed nonstreaming response and SDK-accepted result separately. Do not require or synthesize a `provider.stream.state` event. |

`createCapture()` supplies the public UUID `run_id`; its existing 32-hex `trace_id` remains the
local identity. Pass that UUID into `launchPlanner({ runId })` so guard audit and diagnostics
agree. Use `trace_<trace_id>` as the SDK trace ID inside `withTrace()`. The console's managed
IPC token stays separate and never enters the file. Map SDK `span_<24-hex>` IDs to adapter-owned
16-hex span IDs in memory, preserving parent links and avoiding a wire-format change. Tool-call,
provider-invocation, and physical-HTTP-attempt IDs are distinct; a tool span links to the model
invocation that requested it even though the model span may have settled before tool execution.

Only the writer owns sequence numbers, timestamps, limits, and file close. The local processor
must emit a bounded projection synchronously when it receives a start or end callback. In the
pinned SDK, some span callbacks are invoked without awaiting their returned promise; an
implementation must test that a synchronous write occurs before the callback first yields and
that pending callback work is settled before `capture.summary`. Never buffer all SDK spans until
run exit: a crash should leave start evidence. The writer's existing 32 KiB line and 32 MiB
file caps apply to both hosts.

## 4. Observation boundaries

| Boundary | Required local evidence | Interpretation limit |
|---|---|---|
| CLI and launcher | Start/configuration, graph endpoint and identity when verified, readiness and cleanup outcome | Startup can fail before model or graph identity is known. |
| SDK processor | Agent/turn/generation/response/function span start and end, timing, status, reported usage and validated response ID | An SDK span cannot prove that a graph write committed. |
| `reliableModel` wrapper | Physical model attempt start/end, original error before circuit wrapping, retry decision, backoff/circuit transition, selected delay | Runner owns retries; a scheduled wait is not an actual new HTTP request. |
| OpenAI client's guarded `fetch` | One HTTP-attempt ID and `X-Client-Request-Id` per physical request; response status, allowlisted headers, `x-request-id`, or original transport error | Headers do not prove that the response body parsed or the agent accepted it. |
| Nonstreaming model result | Request/response IDs, returned usage if present, SDK-normalized success or error | There is no raw streaming terminal event in this path. HTTP 200 alone does not establish generation completion. |
| SDK tool callback and gateway | Canonical tool name, guard allow/deny, dispatch boundary, MCP `isError`, returned typed summary, thrown error | A lost response after dispatch leaves effects unknown. |
| Read-only graph inspection | Selected deal, database identity, roadmap/gate facts, observation time, completeness or read failure | Snapshot is a point-in-time observation, not a replay or authorization decision. |
| Finalization | Independent provider/client/graph outcomes, selected failing invocation, capture health, cleanup errors | A complete log can describe a failed planner run. |

The guarded fetch must wrap only the OpenAI client's configured fetch for this process. Keep
`maxRetries: 0` on that client so the Runner remains the sole retry owner. Add a fresh client
request ID to the outgoing headers without reading, cloning, teeing, or replacing the response
body for diagnostics. Capture response headers before the OpenAI client parses an error body;
retain them if parsing fails. Validate the actual request shape and header behavior in the
pinned OpenAI client 7.19.0. Do not record request or response bodies, prompts, tool inputs,
model output, Cypher, MCP payloads, URLs with queries, credentials, or free-form SDK errors.

For a nonstreaming response, use these outcome rules:

- A fetch rejection proves a client transport failure; provider completion is unknown.
- HTTP status and headers prove only that headers arrived. A body parse failure after HTTP 200
  leaves provider completion unknown unless the SDK exposed a parsed response ID independently.
- A parsed Responses object with a successful status is provider-response evidence. The
  `ModelResponse` returned to the Runner proves SDK normalization for that attempt.
- A final `runner.run()` result with a string final output proves the host accepted its result.
  It does not prove stdout delivery to a human or graph commitment.
- An earlier tool-use response cannot supply success for a later failing final turn. Report the
  last blocking attempt as `outcome_scope` on failure.

The triage reader must verify each conclusion from file records, not trust `run.finished`
alone. Reuse the Pi specification's evidence references, unknown states, and read-only checks.
The current `readCapture()` validates basic file shape and span settlement only; richer semantic
validation, triage, and a terminal view are shared package work, not OpenAI-only readers.

## 5. Failure handling and removal

Projection and writer failure latches capture degradation, warns once on stderr, and leaves
model/tool control flow unchanged. Preserve the original exception object through tracing
wrappers. Start records are written before work; `run.finished` follows planner and resource
cleanup. Close the writer after SDK span settlement on success, failure, SIGINT, and SIGTERM,
with a bounded deadline. A hard kill may leave an unfinished file, which the reader marks
partial. No telemetry callback may retry a model call, MCP call, gate request, or graph write.

Remove `examples/openai-agents/src/tracing.ts`'s remote-export implementation, its batch
processor and five-second export flush, the `--trace` CLI option, dashboard URL output, and
tests and docs that present remote tracing as an operator diagnostic path. Replace only the
useful app-owned attempt/retry/tool observation points with calls to the shared local adapter.
Keep SDK tracing enabled only when local metadata capture is active. Update the current
behavior sections in `DESIGN.md`, `OPENAI-AGENTS-SDK.md`, the root and example READMEs, and
verification notes in the implementation change; this proposal does not rewrite those
descriptions before runtime behavior changes.

## 6. Acceptance criteria

Tests are deterministic and use fake models, fake HTTP, and a disposable graph. They require
no live model, trace dashboard, external tracing service, or real API key.

| ID | Acceptance | Oracle |
|---|---|---|
| OA01 | Existing Pi records remain valid and readable | Pi fixtures and capture tests pass after additive schema/API changes. |
| OA02 | Local capture replaces remote export | CLI default produces one private local file; `off` produces none; fake HTTP sees zero calls to `/v1/traces/ingest`; no batch exporter is constructed. |
| OA03 | SDK and local identities correlate | One run ID joins guard audit, local trace, SDK trace, turns, attempts, and tools; managed token is absent from records and stderr. |
| OA04 | SDK metadata is safe | Hostile prompts, tool output, nested exceptions, credentials, paths, and arbitrary SDK span fields never appear in JSONL; only allowlisted names/attributes survive. |
| OA05 | Physical requests and retries are counted honestly | Fake 429/503, connection reset, circuit probe, and cancellation preserve original error and request IDs; every actual fetch has one HTTP ID; scheduled waits do not count as requests. |
| OA06 | Nonstreaming outcomes are evidence-based | HTTP 200 parse failure, parsed response followed by normalization failure, earlier tool turn followed by final failure, and ordinary success yield distinct provider/client outcomes. |
| OA07 | Tool effects and graph observations remain independent | Guard denial is not dispatched; response loss after test gate commit is unknown until a read-only snapshot; graph/database mismatch cannot be merged. |
| OA08 | Diagnostics do not change execution | On/off runs use identical model requests, retry decisions, tool calls, result/error identity, and graph writes; injected writer/processor failures do not repeat operations. |
| OA09 | Partial capture remains useful | Child killed after a span start leaves readable evidence with unfinished status; late callback, writer failure, close timeout, and truncated tail cannot produce a false complete report. |
| OA10 | Repository gates pass | Focused tests and `/verify`, including the denylist status, pass or are reported honestly; tool surface and planner contracts are unchanged. |

Implementation order: extend and test the shared contract/reader; add the local SDK processor;
instrument fetch/retry and the backend-neutral harness observer; add graph/triage evidence;
remove remote tracing and update current-behavior docs; then run `/verify`. A live rehearsal may
collect a local file later, but it is not a prerequisite for deterministic acceptance.
