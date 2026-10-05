// After (a): the same wrong-schema check, written the way every validator in graph/queries/validators is:
// OPTIONAL MATCH the examined set, return exactly one row, and treat "examined = 0" as a failure.
OPTIONAL MATCH (s:Selection {deal_code: $deal, iteration: $iteration})-[:USES]->(p:Pattern)
WITH count(p) AS examined
RETURN examined, CASE WHEN examined = 0 THEN 'FAIL: nothing checked' ELSE 'PASS' END AS verdict;
