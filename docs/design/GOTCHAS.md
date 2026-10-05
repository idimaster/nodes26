# The 9 gotchas: reproducible before and after

Each one lives in `gotchas/NN-slug/` with:
- `README.md`: what we did, what broke, the fix.
- `before.(cypher|ts)` and `after.(cypher|ts)`.
- `test.ts`: asserts that **before fails and after passes**, against a fixture graph loaded in `beforeAll`.

The folders share `gotchas/_shared/fixture.ts` (the demo graph and the agent's templates) and nothing else: every `after` imports the real guard, ontology server, gate store, validators, scheduler, or tool-surface check. Gotcha 03 relies on `npm run check:tools`, which is a CI step.

| # | Folder | Before (demonstrates the failure) | After (the fix) |
|---|---|---|---|
| 1 | `01-schema-is-not-a-contract` | Agent relies on `get-schema`; on an empty graph it returns nothing, and an invented label is accepted | `get_ontology` returns allowed terms; guard G6 denies the invented label |
| 2 | `02-prompt-rules-are-not-guardrails` | Unbounded path, missing `$deal`, and `DETACH DELETE` all execute | `guard.validate` denies each, with an actionable reason |
| 3 | `03-tool-allowlist-drift` | Fixture agent frontmatter missing tools that the skill references | `check-tool-surface` reports the diff, and CI fails |
| 4 | `04-graph-as-index` | Selection stores only `file_path`, so the question "alternatives within 20 points?" is unanswerable in Cypher | Selection + Candidate nodes answer it in one query |
| 5 | `05-dynamic-label-sprawl` | Two near-duplicate labels for one concept, and a query on one misses the other | Proposed → approved deal-scoped term; the guard rejects the variant |
| 6 | `06-feedback-lost-in-chat` | Feedback only in a text field, so "what changed since my review, and why?" can't be answered | Iteration + Feedback nodes; `iteration_diff` answers it |
| 7 | `07-validators-that-fail-open` | (a) Validator on a wrong schema returns 0 rows, which reads as PASS. (b) A track-level fallback marks an uncovered gap as covered | `examined` count → `FAIL: nothing checked`; exact provenance → gap reported |
| 8 | `08-cycles-and-gds-direction` | (a) Scheduler without a cycle check never terminates (test uses a timeout). (b) Projection with `DEPENDS_ON` direction gives the wrong critical path | Cycle check first, with witness; flipped projection matches the Kahn parity result |
| 9 | `09-engine-ahead-of-data` | Catalog fixture with relationship edges on 3 of 25 patterns: V1 and V2 pass a plan that should fail | V7 coverage report fails CI below 0.6; the enriched fixture makes V1 and V2 fire |
