// Before (a): a conflict check written against a schema that is not the graph's (USES instead of SELECTS).
// It matches nothing, returns zero rows, and the caller reads "no violations" as PASS.
MATCH (a:Selection {deal_code: $deal, iteration: $iteration})-[:USES]->(pa:Pattern)-[:CONFLICTS]-(pb:Pattern)<-[:USES]-(b:Selection {deal_code: $deal, iteration: $iteration})
WHERE pa.id < pb.id
RETURN pa.id AS a, pb.id AS b;
// Before (b): coverage with a track-level fallback. A critical gap counts as covered when it is framed into a
// use case whose track has any selected pattern, even if that use case itself was never selected.
MATCH (:Deal {code: $deal})-[:HAS_FINDING]->(f:Finding)
WHERE coalesce(f.classified_as, f.kind) = 'gap' AND f.severity = 'critical'
  AND NOT EXISTS {
    MATCH (f)<-[:FRAMED_FROM]-(:FramedUseCase {deal_code: $deal, iteration: $iteration})-[:INSTANCE_OF]->(:UseCase)
          <-[:SOLVES]-(:Pattern)-[:IN_TRACK]->(:Track)<-[:IN_TRACK]-(:Pattern)<-[:SELECTS]-(:Selection {deal_code: $deal, iteration: $iteration})
  }
RETURN f.id AS uncovered;
