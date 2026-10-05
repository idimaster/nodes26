# 04: The graph as an index

**What we did.** The first prototype kept the plan in markdown files and used the graph as an index: a `Selection` node with a `file_path`.

**What broke.** The interesting facts (each candidate's fit score, the runner-up, how close it was) lived in the file. The architect's first question at the select gate, "were there alternatives within 20 points?", could not be answered in Cypher, and neither could a validator or the near-miss repair (gotcha 07, V2) reason about them.

**The fix.** Model the decision, not the document. Every scored option is a `Candidate` node with its `fit_score` and `signal_snapshot`, linked `ALTERNATIVE_TO` the `Selection`. The question becomes one query, which the gate console (`GateStore.listGates`) runs for every selection it shows.

- Before: [`before.cypher`](before.cypher)
- After: [`after.ts`](after.ts), using the gate store's alternatives query
- Test: [`test.ts`](test.ts)
