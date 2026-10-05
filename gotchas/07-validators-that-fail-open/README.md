# 07: Validators that fail open

**What we did.** We wrote validators as "find the violations" queries. No rows meant no violations.

**What broke.**
- **(a) A wrong schema reads as a pass.** A conflict check written against `[:USES]`, when the graph says `[:SELECTS]`, matches nothing and returns zero rows. That looks exactly like a clean plan. The same happens with a misspelled label, a wrong `$deal`, or an iteration that was never written.
- **(b) A fallback marks a gap as covered.** To be "helpful", coverage accepted any selected pattern in the same *track* as the use case the critical gap was framed into. In the test, P1's critical gap (`f-no-scim`, no SCIM, leavers keep access) is framed into user provisioning, which is never selected. The fallback calls it covered, because an unrelated identity pattern was selected.

**The fix.**
- **(a)** Every validator in `graph/queries/validators/` is written fail-closed. It `OPTIONAL MATCH`es the examined set, returns exactly one row with `examined`, and reports `examined = 0` as **`FAIL: nothing checked`**, never as PASS.
- **(b)** V4 uses exact provenance only: `Finding ← FRAMED_FROM ← FramedUseCase ← FOR ← Selection` in this iteration, with no track or use-case fallback.

- Before: [`before.cypher`](before.cypher)
- After: [`after.cypher`](after.cypher) (the fail-closed shape) and [`after.ts`](after.ts) (the real V2 and V4, through `runValidators`)
- Test: [`test.ts`](test.ts)
