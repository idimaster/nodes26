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
