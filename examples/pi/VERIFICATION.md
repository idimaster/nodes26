# Initial implementation verification

Automated checks use the disposable local Compose graph; no live model is called. Exact runtime
verification uses Node 24.21.0 and npm 11.19.0. Pi agent-core and pi-ai are both pinned to 1.5.0.

| Check | Result |
|---|---|
| Neo4j Compose service | Healthy |
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm test` | Pass: full suite, including existing deterministic P1–P6 walks |
| Focused harness/Pi/recovery/readiness tests | Pass |
| `npm run check:tools` | Pass: skill = allowlist, served tools and guard coverage agree |
| CLI `--help` | Pass |
| `git diff --check` | Pass |
| `npm run denylist` | Skipped: `DENYLIST_FILE` is unset (command exits 2) |
| Independent read-only spec review | Pass with nits; live-provider acceptance pending |

| Design acceptance area | Status and evidence |
|---|---|
| Prompt/15-tool parity | Met: definition and real MCP integration tests; no ambient tools |
| Guard, G8 and fresh ontology context | Met: denied/allowed calls, graph failure, missing/rejected/wrong-deal/wrong-iteration gate tests; approved-term refresh |
| Startup, schema, discovery, cleanup failures | Met: malformed/empty definitions, missing tools, failed discovery/connection, rejecting close and model-construction failure tests |
| Graph identity | Met: environment and CLI override refusal; shared managed settings; reset checks local Docker endpoint, Compose port/credentials and matching database IDs |
| Console ownership/lifecycle | Met: occupied-port real integration, readiness token/timeout, console loss and HTTP override tests |
| Lost gate/recovery | Covered: graph-derived decided/multiple gate IDs and ontology gate state, plus fresh-process inspection; exhaustive transport-interruption variants remain untested |
| Dataset readiness | Covered: empty/incomplete graph, changed keyed findings, missing edges, full-precision history datetime changes; verifier checks all fixture nodes/edges/properties and constraints |
| Retained global terms/reset | Met: actual ontology approval/promotion, two validated Compose resets, unchanged metadata/constraint, baseline vs physical counts, strict-loader rejection and invalid-retained-term matrix |
| Reset target/scope | Met: remote/wrong-port/user/password refusal; all-deals reset documented; failed-reload state rejected by a new process |
| Deal binding | Met: writer/top-level scheduler/ontology/feedback mismatches and trusted gate-only lookup denial before downstream calls |
| Deadline, queue and tool results | Covered: explicit 60-second MCP requests, pending gate identity retained by existing server, cancelled queued write denied, structured error witnesses retained; exhaustive timeout matrix remains untested |
| Provider budget | Met: endless fake-provider tool loop makes exactly three provider requests at a budget of three and returns incomplete |
| Planner behavior through Pi | Met for scripted Nimbus and feedback recordings: real MCP/HTTP architect decisions, committed roadmap/iteration two and exact graph/validator parity |
| Live Anthropic/OpenAI P1–P6 rehearsals | **Not met**: no provider API keys configured; both remain experimental until five successful rehearsals per provider |

The initial implementation is runnable with a provider API key. Passing deterministic checks does
not establish live model quality or complete the live-provider rehearsal acceptance criteria.
