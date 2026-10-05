// Before: one plan, edited in place; the reviewer's feedback is a text field (the chat transcript, in effect).
MERGE (s:Selection {deal_code: $deal, iteration: 1, uc: 'ledger-data-sync'})
SET s.pattern = 'cdc-replication', s.fit_score = 85.3, s.rationale = 'Highest fit score.', s.status = 'draft'
RETURN s.pattern AS pattern;
// The architect rejects in chat; the agent stores the comment and re-plans over the same node.
MATCH (s:Selection {deal_code: $deal, iteration: 1, uc: 'ledger-data-sync'})
SET s.review_comment = $comment, s.pattern = 'event-bus-bridge', s.fit_score = 84.4
RETURN s.pattern AS pattern;
// "What changed since my review, and why?" The graph only knows the present.
MATCH (s:Selection {deal_code: $deal, uc: 'ledger-data-sync'})
RETURN s.iteration AS iteration, s.pattern AS pattern, s.review_comment AS comment;
