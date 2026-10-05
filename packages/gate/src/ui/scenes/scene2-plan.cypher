// Scene 2, Plan (T4.2 addendum §4.1): the iteration's plan nodes, the findings they were framed from, and
// the patterns they select. Groups in priority order. Always one row.
OPTIONAL MATCH (i:Iteration {deal_code: $deal, n: $iteration})
OPTIONAL MATCH (x)-[:IN_ITERATION]->(i)
WITH i, collect(DISTINCT x) AS planNodes
OPTIONAL MATCH (fu:FramedUseCase)-[:FRAMED_FROM]->(f:Finding)
WHERE fu IN planNodes
WITH i, planNodes, collect(DISTINCT f) AS findings
OPTIONAL MATCH (s:Selection)-[:SELECTS]->(p:Pattern)
WHERE s IN planNodes
WITH i, planNodes, findings, collect(DISTINCT p) AS patterns
OPTIONAL MATCH (cd:CapabilityDecision {deal_code: $deal, iteration: $iteration})
WITH i, planNodes, findings, patterns, collect(DISTINCT cd) AS decisions
RETURN [
  CASE WHEN i IS NULL THEN [] ELSE [i] END,
  [n IN planNodes WHERE n:Selection],
  [n IN planNodes WHERE n:FramedUseCase],
  [n IN planNodes WHERE n:PlanTask],
  findings,
  patterns,
  [n IN planNodes WHERE n:Candidate],
  decisions
] AS groups
