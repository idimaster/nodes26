// Before (a): the scheduler's input, read straight from the plan (no cycle check first).
MATCH (pt:PlanTask {deal_code: $deal, iteration: $iteration})
RETURN pt.id AS id, pt.weeks_e AS weeks_e,
       COLLECT { MATCH (pt)-[:DEPENDS_ON]->(b:PlanTask {deal_code: $deal, iteration: $iteration}) RETURN b.id } AS deps
ORDER BY id;
// Before (b): a GDS projection that follows DEPENDS_ON as stored: from the dependent to its prerequisite.
MATCH (a:PlanTask {deal_code: $deal, iteration: $iteration})
OPTIONAL MATCH (a)-[:DEPENDS_ON]->(b:PlanTask {deal_code: $deal, iteration: $iteration})
WITH gds.graph.project($name, a, b, {relationshipProperties: {w: a.weeks_e}}) AS g
RETURN g.nodeCount AS nodes;
CALL gds.dag.longestPath.stream($name, {relationshipWeightProperty: 'w'}) YIELD targetNode, totalCost
RETURN gds.util.asNode(targetNode).id AS id, totalCost AS earliest_start
ORDER BY id;
CALL gds.graph.drop($name, false) YIELD graphName RETURN graphName;
