---
name: plan-integration
description: Plan the integration of an acquired company on the Neo4j graph. Frames findings into use cases, scores catalog patterns, gets architect approval at each gate, and commits a scheduled roadmap. Use when asked to plan, re-plan, or commit an integration for a deal (for example "plan the Nimbus integration").
---

# Plan an integration

**The LLM proposes; the graph decides.** You choose and explain. Classification, scoring, task
instantiation, scheduling, and every validation come from tools. The graph is the record: anything
not written there did not happen.

## Rules

1. **Write only through templates.** For every write, call `mcp__planner-engine__cypher_template`
   with the template name, then send its exact `query` with params that match its `params_schema` to
   `mcp__neo4j-write__write-cypher`. Never hand-write a write query.
2. **Check every count.** Each template returns counts. If a count is lower than the number of rows
   you sent, something was refused (an unknown id, a committed iteration, a different pattern for an
   existing selection). Stop, read it back with `mcp__neo4j-read__read-cypher`, fix the input, and only
   then continue.
3. **A guard denial is a message to you.** Its reason names the rule (G1–G9) and the fix. Correct the
   query or params. Do not work around a rule. If you need a label that does not exist, propose it (step 4).
4. **Gates are the architect's.** `mcp__gate__request_approval` waits up to 50 seconds. While the
   status is `pending`, keep calling `mcp__gate__await_approval` with the `gate_id`. Do not continue
   past a gate until it is `approved`. If it is `rejected`, stop and report the feedback and overrides.
5. **Repairs are bounded.** Retry a failed step at most twice, then stop and explain what blocks you.
6. Every per-deal query takes `$deal`. Reads go to `mcp__neo4j-read__read-cypher` with the named
   queries below.

## Steps

**1. Ground.** Call `mcp__ontology__get_ontology` with the deal: it lists what you may write. Then call
`mcp__neo4j-read__get-schema`, which shows only what exists. Run `findings`, `coverage`, and `next_iteration`.

**2. Classify.** Call `mcp__planner-engine__classify_finding` with all findings at once. Write the
result with template `classify_findings`.

**3. Strategy.** Call `mcp__planner-engine__recommend_strategy` with the classified findings, each
capability finding's `capability_type`, and the coverage map. Keep the top strategy and its rationale
for the frame gate.

**4. Frame.** Write the iteration with template `create_iteration` (`n` from `next_iteration`,
`started_at` now in UTC). Run `use_cases`. For each gap, risk, and capability finding that needs
integration work, choose the use case it belongs to. Several findings may share one framed use case.
Write a one-sentence `framing_rationale` that names the findings. Write all framings with
`write_framed_use_cases`. Then call `mcp__gate__request_approval` with `gate: "frame"`, the subjects
`FramedUseCase:<use_case_id>` for every framing, and a summary that states the recommended strategy, its
score, and its rationale. When approved, write the strategy with `set_deal_strategy`.

If a finding expresses a constraint the ontology has no label for (for example a data-residency requirement),
call `mcp__ontology__propose_term` with `kind: "label"`, an UpperCamelCase `name`, a one-sentence `definition`,
an `example`, and the finding in `motivated_by`. It asks the architect; while `pending`, call
`mcp__gate__await_approval`. Once it is `approved`, write **one** node of the new label for this deal. This is the
only write you may compose yourself, and it must look like this:
`MERGE (r:<Label> {deal_code: $deal, id: $id}) SET r.description = $text RETURN r.id AS id`.
If the term is rejected, record the finding in the summary instead.

**5. Retrieve and score.** For each framed use case, run `candidates` with its `use_case` and
`selected_patterns`. Call `mcp__planner-engine__analyze_pattern_fit` with:
- the use case (`use_case_id`, its description, and the text of the findings it was framed from);
- the deal context (strategy, `target_company`, `acquirer`, `selected_patterns`);
- the candidates.

Write the top three with `write_candidates` (`signal_snapshot` is the JSON of `signals`).

**6. Select.** For each use case, choose a pattern from its candidates, normally the top one. Explain
in `rationale` why, especially when you pass over a higher score. Write with `write_selections`. Call
`mcp__gate__request_approval` with `gate: "select"`, the subjects `Selection:<uc>`, and a summary that
lists each choice and its score.

**7. Instantiate.** Write the plan with template `write_plan_tasks` and only `{deal, iteration}`. The
graph creates every PlanTask and every `DEPENDS_ON` edge from the catalog; you never pass tasks,
durations, or dependencies. Run `pattern_tasks` with the selected pattern ids. The `tasks` count the
template returns must equal the total number of tasks it lists (rule 2).

**8. Validate.** Run `v1`, `v2`, `v3`, `v4`, `v5`, `v6`, and `v6b` with `deal` and `iteration`. Each returns one
row: `{check, examined, violations, verdict}`. Every violation has a `witness` (ids) and a `detail`.
- `PASS` is fine. `WARN` (only `v6b`) goes into the summary.
- `FAIL: nothing checked` means the plan is not in the graph. Stop and find out why; never treat it as a pass.
- **V3 FAIL**, a task cycle: stop. Do not schedule or commit. Report the witness and the selection it came from.
- **V1 FAIL**, a missing prerequisite: *derive* it. Handle only violations whose witness has exactly two ids,
  `[required_by, missing]`; longer chains resolve in the next round, once their middle pattern is selected. Run
  `derive_prerequisite` with `required_by` and `missing`. Frame the first of the returned `use_cases` from the
  returned `finding_ids`, with a rationale that says which pattern needs it. Score its candidates (step 5), then
  write the Selection with `pattern` = the missing pattern and `rationale` "Required by <required_by> (V1)", even if
  it is not the top candidate. If `use_cases` or `finding_ids` is empty, stop and ask the architect. Handle each
  missing pattern once.
- **V2 FAIL**, conflicting selections: switch one of the two use cases to its stored near-miss. Run `near_miss` for
  each use case in the detail, and switch the one that loses fewer points. Call template `replace_selection` with
  the near-miss pattern, its `fit_score`, and a rationale naming the conflict. If neither use case returns a row,
  there is no safe alternative: stop and ask the architect. Never pick a conflicting or excluded pattern yourself.
- **V5 FAIL**, an excluded pattern: run `near_miss` for that use case and switch to it with `replace_selection`.
  If it returns no row, stop and ask the architect.
- V3 checks cycles of up to 10 tasks. Scheduling refuses longer ones, so a schedule error still means stop.
- **V4 FAIL**, an uncovered critical gap: frame, score, and select a use case for that finding (steps 4–6 for it).
- **V6 FAIL**, a missing score or rationale: write the missing value again with the same template.

After any repair, run `write_plan_tasks` again (it rebuilds the plan from the catalog), then validate again. Make
at most **two** repair rounds. If a check still fails, stop and report it, with its witness, to the architect.

**9. Schedule.** Call `mcp__planner-graph__schedule_plan` with `deal` and `iteration`. The graph schedules the
stored plan itself (V3 first, then GDS or Kahn) and writes the result; you never send start times.
- **If `status` is `cycle`**, the plan cannot be scheduled. Do not commit. Report the witness and the selection it
  came from, and stop. A different selection is the architect's call.
- **Otherwise**, keep `finish`, `critical_path`, `pert`, and `resource_load` for the commit summary.

**10. Commit.** Run `next_roadmap_version`. Call `mcp__gate__request_approval` with `gate: "commit"`, the
subjects `Selection:<uc>` and `Iteration:<n>`, and a summary that has the finish week, the PERT p10 to
p90 band, the critical path, every derived or repaired selection with the reason, and every `WARN`. When approved, write with `commit_roadmap`, passing the approved
`gate_id`, the `iteration`, and the `version`.

**11. Report.** Summarize the plan: selections, critical path, finish, PERT band, and every gate
decision. Name anything you could not do.

## Named read queries

Send these to `mcp__neo4j-read__read-cypher` exactly as written.

<!-- query: findings -->
```cypher
MATCH (d:Deal {code: $deal})-[:HAS_FINDING]->(f:Finding)
OPTIONAL MATCH (f)-[:IS_A]->(c:CapabilityType)
RETURN f.id AS id, f.kind AS kind, f.text AS text, f.severity AS severity, f.confidence AS confidence,
       f.evidence_type AS evidence_type, c.id AS capability_type,
       d.target_company AS target_company, d.acquirer AS acquirer
ORDER BY id
```

<!-- query: coverage -->
```cypher
MATCH (:PlatformCapability)-[p:PROVIDES]->(c:CapabilityType)
RETURN c.id AS capability_type, max(p.coverage) AS coverage
ORDER BY capability_type
```

<!-- query: next_iteration -->
```cypher
OPTIONAL MATCH (i:Iteration {deal_code: $deal})
RETURN coalesce(max(i.n), 0) + 1 AS n
```

<!-- query: use_cases -->
```cypher
MATCH (u:UseCase)
RETURN u.id AS id, u.display AS display, u.description AS description
ORDER BY id
```

<!-- query: candidates -->
```cypher
MATCH (u:UseCase {id: $use_case})<-[:SOLVES]-(p:Pattern)
RETURN p.id AS id, p.name AS name, p.description AS description,
       COLLECT { MATCH (p)-[:SOLVES]->(x:UseCase) RETURN x.id ORDER BY x.id } AS solves,
       COLLECT { MATCH (p)-[:APPLIES_TO]->(s:Strategy) RETURN s.id ORDER BY s.id } AS strategies,
       COLLECT { MATCH (p)-[:REQUIRES]->(r:Pattern) RETURN r.id ORDER BY r.id } AS requires,
       coalesce(p.not_recommended_when, []) AS not_recommended_when
ORDER BY id
```

<!-- query: pattern_tasks -->
```cypher
UNWIND $patterns AS pattern_id
MATCH (p:Pattern {id: pattern_id})
RETURN p.id AS pattern,
       COLLECT { MATCH (p)-[:REQUIRES]->(r:Pattern) RETURN r.id ORDER BY r.id } AS requires,
       COLLECT {
         MATCH (p)-[:HAS_TASK]->(t:Task)
         RETURN {id: t.id, weeks_o: t.weeks_o, weeks_e: t.weeks_e, weeks_p: t.weeks_p, skill: t.skill,
                 depends_on: COLLECT { MATCH (t)-[:DEPENDS_ON]->(d:Task) RETURN d.id ORDER BY d.id }}
         ORDER BY t.id
       } AS tasks
```

<!-- query: near_miss -->
```cypher
MATCH (s:Selection {deal_code: $deal, iteration: $iteration, uc: $uc})
MATCH (c:Candidate {deal_code: $deal, iteration: $iteration, uc: $uc})-[:OF]->(p:Pattern)
WHERE c.pattern <> s.pattern
  AND NOT EXISTS {
    MATCH (p)-[:CONFLICTS]-(:Pattern)<-[:SELECTS]-(other:Selection {deal_code: $deal, iteration: $iteration})
    WHERE other.uc <> $uc
  }
  AND NOT EXISTS {
    MATCH (o:Override {deal_code: $deal, kind: 'exclude_pattern', subject: p.id})
    WHERE o.active = true
  }
RETURN c.pattern AS pattern, c.fit_score AS fit_score, s.pattern AS current, s.fit_score AS current_score,
       s.fit_score - c.fit_score AS points_lost
ORDER BY fit_score DESC, pattern
LIMIT 1
```

<!-- query: derive_prerequisite -->
```cypher
OPTIONAL MATCH (s:Selection {deal_code: $deal, iteration: $iteration})-[:SELECTS]->(:Pattern {id: $required_by})
OPTIONAL MATCH (s)-[:FOR]->(:FramedUseCase)-[:FRAMED_FROM]->(f:Finding)
WITH collect(DISTINCT f.id) AS finding_ids
OPTIONAL MATCH (:Pattern {id: $missing})-[:SOLVES]->(u:UseCase)
WITH finding_ids, u
ORDER BY u.id
WITH finding_ids, collect(u.id) AS solves
RETURN finding_ids,
       [x IN solves WHERE NOT EXISTS {
         MATCH (:Selection {deal_code: $deal, iteration: $iteration, uc: x})
       }] AS use_cases
```

<!-- query: next_roadmap_version -->
```cypher
OPTIONAL MATCH (r:Roadmap {deal_code: $deal})
RETURN coalesce(max(r.version), 0) + 1 AS version
```

## Validator queries

<!-- validators:start -->
<!-- generated from graph/queries/validators by npm run skill:sync; do not edit by hand -->

<!-- query: v1 -->
```cypher
// V1 prerequisite closure (DESIGN §5.1, constraint): every pattern a selected pattern REQUIRES
// (up to 5 hops) is selected too. Witness: the REQUIRES path from the selected to the missing pattern.
// The skill derives (adds) the missing prerequisite.
OPTIONAL MATCH (s:Selection {deal_code: $deal, iteration: $iteration})
OPTIONAL MATCH (s)-[:SELECTS]->(p:Pattern)
WITH count(s) AS examined, collect(DISTINCT p) AS selected
CALL (selected) {
  UNWIND selected AS p
  MATCH path = (p)-[:REQUIRES*1..5]->(missing:Pattern)
  WHERE NOT missing IN selected
  WITH p, missing, path
  ORDER BY p.id, missing.id, length(path)
  WITH p, missing, head(collect(path)) AS path
  RETURN collect({
    witness: [n IN nodes(path) | n.id],
    witness_eids: [n IN nodes(path) | elementId(n)],
    detail: p.id + ' requires ' + missing.id + ', which is not selected'
  }) AS violations
}
RETURN 'V1' AS check, examined, violations,
       CASE WHEN examined = 0 THEN 'FAIL: nothing checked' WHEN size(violations) > 0 THEN 'FAIL' ELSE 'PASS' END AS verdict
```

<!-- query: v2 -->
```cypher
// V2 conflicting selections (DESIGN §5.1, constraint): no two selected patterns CONFLICT (either direction).
// Witness: the two patterns. The skill repairs by switching one use case to its stored near-miss.
OPTIONAL MATCH (s:Selection {deal_code: $deal, iteration: $iteration})
WITH collect(s) AS selections
CALL (selections) {
  UNWIND selections AS a
  UNWIND selections AS b
  MATCH (a)-[:SELECTS]->(pa:Pattern)-[:CONFLICTS]-(pb:Pattern)<-[:SELECTS]-(b)
  WHERE pa.id < pb.id
  WITH DISTINCT a, b, pa, pb
  ORDER BY pa.id, pb.id, a.uc, b.uc
  RETURN collect({
    witness: [pa.id, pb.id],
    witness_eids: [elementId(pa), elementId(pb)],
    detail: a.uc + ' selects ' + pa.id + ', which CONFLICTS with ' + pb.id + ' selected for ' + b.uc
  }) AS violations
}
RETURN 'V2' AS check, size(selections) AS examined, violations,
       CASE WHEN size(selections) = 0 THEN 'FAIL: nothing checked' WHEN size(violations) > 0 THEN 'FAIL' ELSE 'PASS' END AS verdict
```

<!-- query: v3 -->
```cypher
// V3 task cycle (DESIGN §5.1, structural): no PlanTask depends on itself through DEPENDS_ON (up to 10 hops).
// Witness: the cycle in DEPENDS_ON order, starting from its smallest id, closed (as the engine's CycleError).
// Only simple cycles count: no task appears twice before the end. Cycles longer than 10 hops are left to
// the scheduler, which refuses any cycle. Scheduling must not run while V3 fails.
OPTIONAL MATCH (t:PlanTask {deal_code: $deal, iteration: $iteration})
WITH collect(t) AS tasks
CALL (tasks) {
  UNWIND tasks AS t
  MATCH path = (t)-[:DEPENDS_ON*1..10]->(t)
  WHERE all(n IN nodes(path) WHERE n:PlanTask AND n.deal_code = $deal AND n.iteration = $iteration AND t.id <= n.id)
    AND size(reduce(seen = [], n IN tail(nodes(path)) | CASE WHEN n IN seen THEN seen ELSE seen + n END)) = length(path)
  WITH DISTINCT [n IN nodes(path) | n.id] AS witness, [n IN nodes(path) | elementId(n)] AS witness_eids
  ORDER BY reduce(k = '', id IN witness | k + id + '>')
  RETURN collect({
    witness: witness,
    witness_eids: witness_eids,
    detail: 'PlanTasks depend on each other in a cycle: ' + reduce(k = head(witness), id IN tail(witness) | k + ' -> ' + id)
  }) AS violations
}
RETURN 'V3' AS check, size(tasks) AS examined, violations,
       CASE WHEN size(tasks) = 0 THEN 'FAIL: nothing checked' WHEN size(violations) > 0 THEN 'FAIL' ELSE 'PASS' END AS verdict
```

<!-- query: v4 -->
```cypher
// V4 uncovered critical gap (DESIGN §5.1, coverage): every critical gap finding of the deal is covered in
// this iteration by exact provenance: Finding <-FRAMED_FROM- FramedUseCase <-FOR- Selection.
// No track or use-case fallback (gotcha 07b). Examined: the iteration's Selections (the plan under check),
// so an empty plan is "nothing checked" and a plan for a deal without critical gaps passes.
OPTIONAL MATCH (s:Selection {deal_code: $deal, iteration: $iteration})
WITH count(s) AS examined
CALL () {
  MATCH (:Deal {code: $deal})-[:HAS_FINDING]->(f:Finding)
  WHERE coalesce(f.classified_as, f.kind) = 'gap' AND f.severity = 'critical'
    AND NOT EXISTS {
      MATCH (f)<-[:FRAMED_FROM]-(:FramedUseCase {deal_code: $deal, iteration: $iteration})<-[:FOR]-(:Selection {deal_code: $deal, iteration: $iteration})
    }
  WITH f ORDER BY f.id
  RETURN collect({
    witness: [f.id],
    witness_eids: [elementId(f)],
    detail: 'critical gap ' + f.id + ' is not framed into any selected use case'
  }) AS violations
}
RETURN 'V4' AS check, examined, violations,
       CASE WHEN examined = 0 THEN 'FAIL: nothing checked' WHEN size(violations) > 0 THEN 'FAIL' ELSE 'PASS' END AS verdict
```

<!-- query: v5 -->
```cypher
// V5 excluded pattern (DESIGN §5.1, coverage): no Selection selects a pattern that an active
// exclude_pattern Override of this deal names. Witness: the pattern and the Override.
OPTIONAL MATCH (s:Selection {deal_code: $deal, iteration: $iteration})
WITH collect(s) AS selections
CALL (selections) {
  UNWIND selections AS s
  MATCH (s)-[:SELECTS]->(p:Pattern)
  MATCH (o:Override {deal_code: $deal, kind: 'exclude_pattern', subject: p.id})
  WHERE o.active = true
  WITH s, p, o ORDER BY s.uc, o.id
  RETURN collect({
    witness: [p.id, o.id],
    witness_eids: [elementId(p), elementId(o)],
    detail: s.uc + ' selects ' + p.id + ', which ' + o.id + ' excludes'
  }) AS violations
}
RETURN 'V5' AS check, size(selections) AS examined, violations,
       CASE WHEN size(selections) = 0 THEN 'FAIL: nothing checked' WHEN size(violations) > 0 THEN 'FAIL' ELSE 'PASS' END AS verdict
```

<!-- query: v6 -->
```cypher
// V6 audit chain (DESIGN §5.1, audit): every Selection has a fit_score and a SELECTS edge, and every
// FramedUseCase a non-empty framing_rationale. Witness: the node's id (a Selection is identified by its uc).
OPTIONAL MATCH (s:Selection {deal_code: $deal, iteration: $iteration})
WITH collect(s) AS selections
OPTIONAL MATCH (fu:FramedUseCase {deal_code: $deal, iteration: $iteration})
WITH selections, collect(fu) AS framings
CALL (selections, framings) {
  UNWIND selections + framings AS n
  WITH n
  WITH n, CASE
    WHEN n:Selection AND n.fit_score IS NULL THEN 'Selection ' + n.uc + ' has no fit_score'
    WHEN n:Selection AND NOT EXISTS { (n)-[:SELECTS]->(:Pattern) } THEN 'Selection ' + n.uc + ' selects no pattern'
    WHEN n:FramedUseCase AND trim(coalesce(n.framing_rationale, '')) = '' THEN 'FramedUseCase ' + n.id + ' has no framing_rationale'
  END AS problem
  WHERE problem IS NOT NULL
  WITH n, problem ORDER BY labels(n)[0], coalesce(n.uc, n.id)
  RETURN collect({witness: [coalesce(n.uc, n.id)], witness_eids: [elementId(n)], detail: problem}) AS violations
}
RETURN 'V6' AS check, size(selections) + size(framings) AS examined, violations,
       CASE WHEN size(selections) + size(framings) = 0 THEN 'FAIL: nothing checked'
            WHEN size(violations) > 0 THEN 'FAIL' ELSE 'PASS' END AS verdict
```

<!-- query: v6b -->
```cypher
// V6b near-miss (DESIGN §5.1, audit): every Selection has another Candidate of its use case within
// 20 points, so a reviewer sees a real alternative. Violations give WARN, not FAIL.
OPTIONAL MATCH (s:Selection {deal_code: $deal, iteration: $iteration})
WITH collect(s) AS selections
CALL (selections) {
  UNWIND selections AS s
  WITH s
  WHERE NOT EXISTS {
    MATCH (c:Candidate {deal_code: $deal, iteration: $iteration, uc: s.uc})
    WHERE c.pattern <> s.pattern AND abs(c.fit_score - s.fit_score) <= 20
  }
  WITH s ORDER BY s.uc
  RETURN collect({
    witness: [s.uc],
    witness_eids: [elementId(s)],
    detail: 'no alternative within 20 points of ' + s.pattern + ' for ' + s.uc
  }) AS violations
}
RETURN 'V6b' AS check, size(selections) AS examined, violations,
       CASE WHEN size(selections) = 0 THEN 'FAIL: nothing checked' WHEN size(violations) > 0 THEN 'WARN' ELSE 'PASS' END AS verdict
```
<!-- validators:end -->
