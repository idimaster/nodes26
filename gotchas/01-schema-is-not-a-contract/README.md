# 01: The schema is not a contract

**What we did.** We let the agent learn the graph's shape from Neo4j itself: `get-schema` (which runs `apoc.meta.schema`; the before file calls it directly) before writing.

**What broke.** The schema describes the data that happens to exist, not the data that is allowed. On an empty graph it returns nothing, so the agent has no vocabulary at all. Worse, nothing stops it from inventing one: `CREATE (:IntegrationThing …)` runs, and from then on `get-schema` reports the invented label as if it were part of the model.

**The fix.** The ontology (`config/ontology.json`) is the contract. The ontology server's `get_ontology` returns the allowed labels and relationship types (and the deal's approved terms) whatever the graph holds. The write guard enforces it: rule **G6** denies any label or type that is not listed, and its reason says how to get a new one (`propose_term`, gotcha 05).

- Before: [`before.cypher`](before.cypher)
- After: [`after.ts`](after.ts), using `OntologyService.getOntology` and `guard.validate`
- Test: [`test.ts`](test.ts)
