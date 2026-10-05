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
   query or params. Do not work around a rule. If you need a label that does not exist, say so and stop
   (proposing terms comes with the ontology server).
4. **Gates are the architect's.** `mcp__gate__request_approval` waits up to 50 seconds. While the
   status is `pending`, keep calling `mcp__gate__await_approval` with the `gate_id`. Do not continue
   past a gate until it is `approved`. If it is `rejected`, stop and report the feedback and overrides.
5. **Repairs are bounded.** Retry a failed step at most twice, then stop and explain what blocks you.
6. Every per-deal query takes `$deal`. Reads go to `mcp__neo4j-read__read-cypher` with the named
   queries below.

## Steps

**1. Ground.** Call `mcp__neo4j-read__get-schema`. Run `findings`, `coverage`, and `next_iteration`.

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

**8. Schedule.** Run `plan_graph` and pass its `plan_tasks` and `depends_on` to
`mcp__planner-engine__compute_schedule` exactly as returned. Never add, drop, or reverse an edge.
- **If it returns a `cycle` error**, the plan cannot be scheduled. Do not write a schedule and do not
  commit. Report the witness and the selection it came from, and stop. A different selection is the
  architect's call.
- **Otherwise**, write the tasks with `write_schedule`, and note the finish and the PERT band for the
  summary.

**9. Commit.** Run `next_roadmap_version`. Call `mcp__gate__request_approval` with `gate: "commit"`, the
subjects `Selection:<uc>` and `Iteration:<n>`, and a summary that has the finish week, the PERT p10 to
p90 band, and the critical path. When approved, write with `commit_roadmap`, passing the approved
`gate_id`, the `iteration`, and the `version`.

**10. Report.** Summarize the plan: selections, critical path, finish, PERT band, and every gate
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

<!-- query: plan_graph -->
```cypher
MATCH (pt:PlanTask {deal_code: $deal, iteration: $iteration})
WITH collect(pt) AS tasks
RETURN [t IN tasks | {id: t.id, weeks_o: t.weeks_o, weeks_e: t.weeks_e, weeks_p: t.weeks_p}] AS plan_tasks,
       COLLECT {
         MATCH (a:PlanTask {deal_code: $deal, iteration: $iteration})-[:DEPENDS_ON]->(b:PlanTask)
         RETURN {from: a.id, to: b.id}
       } AS depends_on
```

<!-- query: next_roadmap_version -->
```cypher
OPTIONAL MATCH (r:Roadmap {deal_code: $deal})
RETURN coalesce(max(r.version), 0) + 1 AS version
```
