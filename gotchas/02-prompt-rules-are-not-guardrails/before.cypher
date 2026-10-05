// Before: the prompt says "bound every path, scope by $deal, never delete". These three statements break
// each rule, and Neo4j runs all of them: a prompt is advice, not enforcement.

// 1. An unbounded variable-length path (the prompt says: at most 10 hops).
MATCH path = (:Task)-[:DEPENDS_ON*]->(:Task) WITH count(path) AS paths MERGE (i:Iteration {deal_code: $deal, n: 1}) SET i.status = 'draft' RETURN paths;
// 2. A per-deal write without $deal: it edits every deal's selections.
MATCH (s:Selection {iteration: 1}) SET s.rationale = 'bulk edit' RETURN count(s) AS edited;
// 3. A destructive write.
MATCH (f:Finding {deal_code: $deal, id: 'f-weak-mfa'}) DETACH DELETE f RETURN count(*) AS deleted;
