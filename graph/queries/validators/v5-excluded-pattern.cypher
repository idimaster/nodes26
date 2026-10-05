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
