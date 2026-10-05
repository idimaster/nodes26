// Relationships among a scene's nodes (T4.2 addendum §4.2), bounded.
MATCH (a)-[r]->(b)
WHERE elementId(a) IN $ids AND elementId(b) IN $ids
RETURN elementId(r) AS id, elementId(a) AS from, elementId(b) AS to, type(r) AS type
LIMIT 600
