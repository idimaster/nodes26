// Before: the agent learns the schema from the graph itself (what the Neo4j MCP get-schema runs: apoc.meta.schema), then writes.
// On an empty graph there is nothing to learn, so nothing says the label below is invented.
CALL apoc.meta.schema({sample: 1000}) YIELD value RETURN [k IN keys(value) WHERE value[k].type = 'node'] AS labels;
CREATE (x:IntegrationThing {deal_code: $deal, id: 'invented-1'}) RETURN x.id AS id;
