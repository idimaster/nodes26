// Before: the catalog as first loaded, with knowledge edges on 3 of the patterns only.
// (Fixture setup: strips every REQUIRES, CONFLICTS, and AUGMENTS edge outside a three-pattern island.)
MATCH (p:Pattern)-[r:REQUIRES|CONFLICTS|AUGMENTS]-(q:Pattern)
WHERE NOT (p.id IN $island AND q.id IN $island)
DELETE r
RETURN count(r) AS removed;
