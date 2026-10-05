// iteration_diff (DESIGN §5.3): what changed in iteration $iteration against the one before, per use case,
// with the text of every Feedback the new selection resolved (RESOLVED_BY). No rows when nothing changed.
CALL () {
  OPTIONAL MATCH (s:Selection {deal_code: $deal, iteration: $iteration})
  RETURN collect(s) AS now
}
CALL () {
  OPTIONAL MATCH (s:Selection {deal_code: $deal, iteration: $iteration - 1})
  RETURN collect(s) AS before
}
WITH now, before, [s IN now | s.uc] + [s IN before WHERE NOT s.uc IN [x IN now | x.uc] | s.uc] AS ucs
UNWIND ucs AS uc
WITH uc, head([s IN now WHERE s.uc = uc]) AS a, head([s IN before WHERE s.uc = uc]) AS b
WITH uc, a, b,
     CASE WHEN b IS NULL THEN 'added' WHEN a IS NULL THEN 'removed' WHEN a.pattern <> b.pattern THEN 'changed' END AS change
WHERE change IS NOT NULL
CALL (a) {
  OPTIONAL MATCH (f:Feedback)-[:RESOLVED_BY]->(a)
  WITH f ORDER BY f.id
  RETURN collect(f.text) AS feedback
}
RETURN uc, change, b.pattern AS before, a.pattern AS after, feedback
ORDER BY uc
