// Before: the graph as an index. The plan lives in a markdown file; the Selection only points at it.
// The scores and the runners-up are in the file, where Cypher cannot see them.
// (Fixture setup: written directly, as the first prototype did.)
MERGE (i:Iteration {deal_code: $deal, n: $iteration})
  ON CREATE SET i.started_at = datetime(), i.status = 'draft'
MERGE (s:Selection {deal_code: $deal, iteration: $iteration, uc: 'ledger-data-sync'})
SET s.file_path = 'plans/nimbus/ledger-data-sync.md'
MERGE (s)-[:IN_ITERATION]->(i)
RETURN s.file_path AS file_path;
