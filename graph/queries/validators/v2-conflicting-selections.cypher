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
