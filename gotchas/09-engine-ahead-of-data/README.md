# 09: The engine ahead of the data

**What we did.** We built the validators first: prerequisite closure (V1), conflicts (V2), and the rest, all tested on hand-made fixtures. Then we loaded a catalog that had relationship edges on only a few patterns.

**What broke.** Nothing visibly. V1 and V2 can only fire on `REQUIRES` and `CONFLICTS` edges that exist. On the sparse catalog, a plan that selects SCIM without its prerequisite trust pattern, and CDC replication next to the batch export it conflicts with, passes both checks. The validators were correct; the data could not trigger them.

**The fix.** Measure the data the engine depends on. V7, knowledge-edge coverage, is the share of catalog patterns with any `REQUIRES`, `CONFLICTS`, or `AUGMENTS` edge. It FAILs below `edge_coverage_floor` (0.6, in `config/thresholds.json`). CI runs it as `npm run coverage:edges` and uploads the report. With the enriched catalog (coverage 0.93), V1 and V2 fire on the same plan.

- Before: [`before.cypher`](before.cypher) (the sparse-catalog fixture)
- After: [`after.ts`](after.ts), using `runValidators` for V1, V2, and V7
- Test: [`test.ts`](test.ts)
