// recall_memory (DESIGN §5.3): what the agent must remember before re-planning. One row: the latest
// iteration and its selections, every open Feedback with what it was about, and every active Override.
CALL () {
  OPTIONAL MATCH (i:Iteration {deal_code: $deal})
  WITH i ORDER BY i.n DESC
  LIMIT 1
  RETURN i
}
CALL (i) {
  OPTIONAL MATCH (s:Selection {deal_code: $deal})-[:IN_ITERATION]->(i)
  WITH s ORDER BY s.uc
  RETURN collect(CASE WHEN s IS NULL THEN null ELSE {uc: s.uc, pattern: s.pattern, status: s.status} END) AS selections
}
CALL () {
  OPTIONAL MATCH (f:Feedback {deal_code: $deal})
  WHERE f.status = 'open'
  OPTIONAL MATCH (f)-[:FROM]->(g:GateDecision)
  WITH f, g,
       COLLECT {
         MATCH (f)-[:ON]->(x)
         RETURN labels(x)[0] + ':' + coalesce(x.uc, x.id, toString(x.n)) + CASE WHEN x:Selection THEN ' -> ' + x.pattern ELSE '' END AS about
         ORDER BY about
       } AS about
  ORDER BY f.id
  RETURN collect(CASE WHEN f IS NULL THEN null ELSE {id: f.id, text: f.text, gate: g.gate, gate_id: g.id, iteration: g.iteration, about: about} END) AS open_feedback
}
CALL () {
  OPTIONAL MATCH (o:Override {deal_code: $deal})
  WHERE o.active = true
  WITH o ORDER BY o.id
  RETURN collect(CASE WHEN o IS NULL THEN null ELSE {id: o.id, kind: o.kind, subject: o.subject, value: o.value} END) AS overrides
}
RETURN i.n AS latest_iteration, i.status AS latest_status, selections, open_feedback, overrides
