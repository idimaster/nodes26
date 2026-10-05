# 05: Dynamic label sprawl

**What we did.** When a finding needed a concept the model lacked, we let the agent create the label it wanted.

**What broke.** Each run named things its own way. One run wrote `:DataResidency`, the next `:DataResidencyRequirement`, for the same concept. A query on one label silently misses the nodes under the other, and nothing ever reconciles them.

**The fix.** New vocabulary is a decision, not a side effect:
1. The guard (G6) denies any label that isn't in the ontology or an active term, and its reason points to `propose_term`.
2. `propose_term` writes a *proposed* `OntologyTerm` with `MOTIVATED_BY` edges to the findings, and opens an `ontology_term` gate.
3. When the architect approves, the gate server activates the term for **this deal only** and adds its key constraint.
4. The guard now accepts exactly that name. The variant stays denied, and other deals still can't use the term unless it is promoted.

- Before: [`before.cypher`](before.cypher)
- After: [`after.ts`](after.ts), using `OntologyService.proposeTerm`, `GateStore.decide`, and `guard.validate`
- Test: [`test.ts`](test.ts)
