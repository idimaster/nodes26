// Scene 1, Knowledge (T4.2 addendum §4.1): patterns in play this iteration, related patterns, and tasks.
// Groups in priority order: selected patterns, other candidates, related patterns, tasks. Always one row.
OPTIONAL MATCH (:Selection {deal_code: $deal, iteration: $iteration})-[:SELECTS]->(sp:Pattern)
WITH collect(DISTINCT sp) AS selected
OPTIONAL MATCH (:Candidate {deal_code: $deal, iteration: $iteration})-[:OF]->(cp:Pattern)
WITH selected, [p IN collect(DISTINCT cp) WHERE NOT p IN selected] AS candidates
WITH selected, candidates, selected + candidates AS pats
OPTIONAL MATCH (p:Pattern)-[:REQUIRES|CONFLICTS|AUGMENTS]-(q:Pattern)
WHERE p IN pats AND NOT q IN pats
WITH selected, candidates, pats, collect(DISTINCT q) AS related
OPTIONAL MATCH (p:Pattern)-[:HAS_TASK]->(t:Task)
WHERE p IN pats
WITH selected, candidates, related, collect(DISTINCT t) AS tasks
RETURN [selected, candidates, related, tasks] AS groups
