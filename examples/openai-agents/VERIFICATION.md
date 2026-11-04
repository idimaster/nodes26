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
