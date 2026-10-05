// Candidate retrieval (DESIGN §5.3): patterns that SOLVE the use case, minus every pattern an active
// exclude_pattern Override of this deal names (a "remove X" at a gate takes X out of the next iteration).
MATCH (u:UseCase {id: $use_case})<-[:SOLVES]-(p:Pattern)
WHERE NOT EXISTS {
  MATCH (o:Override {deal_code: $deal, kind: 'exclude_pattern', subject: p.id})
  WHERE o.active = true
}
RETURN p.id AS id, p.name AS name, p.description AS description,
       COLLECT { MATCH (p)-[:SOLVES]->(x:UseCase) RETURN x.id ORDER BY x.id } AS solves,
       COLLECT { MATCH (p)-[:APPLIES_TO]->(s:Strategy) RETURN s.id ORDER BY s.id } AS strategies,
       COLLECT { MATCH (p)-[:REQUIRES]->(r:Pattern) RETURN r.id ORDER BY r.id } AS requires,
       coalesce(p.not_recommended_when, []) AS not_recommended_when
ORDER BY id
