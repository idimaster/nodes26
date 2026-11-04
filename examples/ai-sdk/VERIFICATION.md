# AI SDK example verification

## Responses provider change — 2026-11-03

Verified with Node **24.21.0** and npm **11.19.0**. The example uses AI SDK **7.0.128**,
`@ai-sdk/openai` **4.0.84**, and `@ai-sdk/provider` **4.0.22**. The OpenAI provider version was
selected to match the pinned provider interface; the newer provider initially caused a TypeScript
finish-reason incompatibility.

The reported `openai-compatible:gpt-6-luna` run sent function tools to `/v1/chat/completions` and
was rejected because reasoning was enabled. New regression tests first reproduced that routing
failure. OpenAI now uses Responses, both through `openai:<model-id>` and through existing
`openai-compatible:` configurations whose base URL has origin `https://api.openai.com`.
Other compatible servers retain Chat Completions.

| Check | Result |
|---|---|
| Isolated Neo4j Compose service | Healthy before the successful final run |
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| Focused AI SDK tests | Pass: 2 files, 10 tests |
| `npm test` | Pass: 83 files, 819 tests; final run completed in 125.72 seconds |
| `git diff --check` | Pass |
| `npm run denylist` | **Skipped**: `DENYLIST_FILE` unset; command exits 2 and reports check not run |
| Live model rehearsal | **Not run** during verification |

The full suite used Compose project `planner-ai-sdk-responses-check`, with its own container and
volumes, Bolt port **47687** and HTTP port **47474**. The demo database on 7687 was not the reset
target. An earlier concurrent verification attempt encountered recovery/ontology failures and
graph-hook timeouts; subsequent probes found the isolated Bolt port refusing connections. That
attempt was interrupted. After the other suite finished and the isolated database was restarted,
the focused tests and full suite passed. The temporary container, network and volumes were removed.
Unrelated Pi, OpenAI Agents and harness changes in the working tree were preserved; the full-suite
count describes that combined working tree.

## Coverage

| Behavior | Status and evidence |
|---|---|
| Embedded prompt | Met: planner instructions contain the full embedded skill exactly once |
| Model selection | Met: Anthropic and compatible model IDs accepted; unknown provider refused |
| OpenAI Responses routing | Met: native OpenAI, custom native base URL, and legacy official OpenAI URLs with/without trailing slash all use `/responses` |
| Provider credentials | Met for the tested OpenAI configurations: mocked HTTP requests carry the configured bearer key |
| Function-call round trip | Met: Responses function call executes once and its result is sent on the next request as `function_call_output` with the same call ID |
| Other compatible endpoints | Met for mocked HTTP: continue to use `/chat/completions` |
| Canonical tool exposure | Met: real MCP tools exactly match the planner allowlist |
| Write guard | Met: destructive query denied before forwarding; valid parameterized write allowed; real MCP denial preserves graph findings |
| Step cap | Met: repeated mock-model tool calls stop at the configured three-step cap |
| Repository regression checks | Met for the recorded final run: full deterministic suite passes |
| Live planning quality | **Not established**: no successful live AI SDK P1–P6 rehearsal is recorded by this verification |

The example-specific tests are
[`ai-sdk.test.ts`](../../tests/examples/ai-sdk.test.ts) and
[`ai-sdk-model.test.ts`](../../tests/examples/ai-sdk-model.test.ts). Passing the broader deterministic
P1–P6 walks does not establish that a live model completes those situations through this host.
T5.3's Claude-model P1–P6 and recorded experimental non-Claude run acceptance remains unverified
by this evidence.

Managed-launch readiness, console ownership, graph/deal binding, custom provider retry/circuit
behavior, cancellation and persisted restart recovery are not claims of this AI SDK example.
Those behaviors in the sibling hosts must not be inferred from the shared repository test count.

## Documentation follow-up

`README.md` and this record document the existing implementation and the verification above.
They add no runtime behavior. The repository README links to both documents. The 819-test result
belongs to the preceding provider change; the full graph suite was not repeated for these
documentation-only additions.

| Documentation check | Result |
|---|---|
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm test -- tests/docs` | Pass: 2 files, 19 tests |
| Local Markdown links and code fences | Pass for both new documents |
| `git diff --check` | Pass |
| `npm run denylist` | **Skipped**: `DENYLIST_FILE` unset; command exits 2 |

Existing runtime, dependency, test and sibling-example edits were preserved.
