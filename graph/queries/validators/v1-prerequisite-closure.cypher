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
