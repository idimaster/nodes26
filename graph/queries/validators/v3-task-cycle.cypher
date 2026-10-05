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
