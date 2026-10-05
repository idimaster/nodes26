// V7 knowledge-edge coverage (DESIGN §5.1, data): the share of catalog patterns with any REQUIRES,
// CONFLICTS, or AUGMENTS edge is at least $floor. Global (no $deal). Violations list uncovered patterns;
// the verdict depends only on the share, which is also returned as coverage.
OPTIONAL MATCH (p:Pattern)
WITH collect(p) AS patterns
CALL (patterns) {
  UNWIND patterns AS p
  WITH p
  WHERE NOT EXISTS { (p)-[:REQUIRES|CONFLICTS|AUGMENTS]-(:Pattern) }
  WITH p ORDER BY p.id
  RETURN collect({witness: [p.id], witness_eids: [elementId(p)], detail: p.id + ' has no REQUIRES, CONFLICTS, or AUGMENTS edge'}) AS violations
}
WITH patterns, violations,
     CASE WHEN size(patterns) = 0 THEN 0.0 ELSE toFloat(size(patterns) - size(violations)) / size(patterns) END AS coverage
RETURN 'V7' AS check, size(patterns) AS examined, violations,
       CASE WHEN size(patterns) = 0 THEN 'FAIL: nothing checked' WHEN $floor IS NULL OR coverage < $floor THEN 'FAIL' ELSE 'PASS' END AS verdict,
       coverage
