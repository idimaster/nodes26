# Gotchas

Nine things that went wrong while building this planner, each reproducible. Every folder has a `README.md` (what we did, what broke, the fix), a `before` file that shows the failure, an `after` file that uses the real fix from this repo, and a `test.ts` that asserts **before fails and after passes**. The full list is in [`docs/design/GOTCHAS.md`](../docs/design/GOTCHAS.md).

| # | Gotcha | The fix lives in |
|---|---|---|
| 01 | [The schema is not a contract](01-schema-is-not-a-contract/) | `get_ontology`, guard G6 |
| 02 | [Prompt rules are not guardrails](02-prompt-rules-are-not-guardrails/) | guard G2, G4, G5 |
| 03 | [Tool allowlist drift](03-tool-allowlist-drift/) | `npm run check:tools` (CI) |
| 04 | [The graph as an index](04-graph-as-index/) | Selection + Candidate nodes |
| 05 | [Dynamic label sprawl](05-dynamic-label-sprawl/) | `propose_term` + ontology gate |
| 06 | [Feedback lost in chat](06-feedback-lost-in-chat/) | Iteration, Feedback, `iteration_diff` |
| 07 | [Validators that fail open](07-validators-that-fail-open/) | `examined` counts; V4 exact provenance |
| 08 | [Cycles and GDS direction](08-cycles-and-gds-direction/) | V3 first; flipped projection |
| 09 | [The engine ahead of the data](09-engine-ahead-of-data/) | V7 edge coverage (CI) |

Run them with `npx vitest run gotchas` (Neo4j must be up; each test reloads the demo graph). They share `_shared/fixture.ts` and nothing else.
