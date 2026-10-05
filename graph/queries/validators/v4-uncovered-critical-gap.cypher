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
