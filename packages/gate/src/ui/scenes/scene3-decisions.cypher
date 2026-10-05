// Scene 3, Decisions (T4.2 addendum §4.1): gate decisions, feedback, overrides, and ontology terms, plus
// what they point at. Groups in priority order. Always one row.
OPTIONAL MATCH (d)
WHERE (d:GateDecision OR d:Feedback OR d:Override) AND d.deal_code = $deal
WITH collect(d) AS decisions
OPTIONAL MATCH (t:OntologyTerm)
WHERE t.scope IN ['global', $deal] AND t.status IN ['proposed', 'active']
WITH decisions, collect(t) AS terms
WITH decisions, terms, decisions + terms AS anchors
OPTIONAL MATCH (a)-[:DECIDED_ON|ON|CONSTRAINS|RESOLVED_BY|MOTIVATED_BY]->(target)
WHERE a IN anchors
WITH decisions, terms, collect(DISTINCT target) AS targets
RETURN [decisions, terms, targets] AS groups
