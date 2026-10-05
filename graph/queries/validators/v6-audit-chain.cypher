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
