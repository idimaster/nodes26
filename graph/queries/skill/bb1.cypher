// BB1 buy vs build (DESIGN §5.3, §2.6): one row per capability type the deal has a capability finding for
// (classified as capability, so weak evidence is excluded). integrate_effort = sum of weeks_e of the
// PlanTasks of every Selection framed from those findings in this iteration (null when none is selected);
// build_effort = the type's BuildOption; coverage = the acquirer's best PROVIDES coverage (0 if none).
MATCH (:Deal {code: $deal})-[:HAS_FINDING]->(f:Finding)-[:IS_A]->(c:CapabilityType)
WHERE coalesce(f.classified_as, f.kind) = 'capability'
WITH c, collect(DISTINCT f) AS findings
CALL (findings) {
  UNWIND findings AS f
  OPTIONAL MATCH (f)<-[:FRAMED_FROM]-(:FramedUseCase {deal_code: $deal, iteration: $iteration})
                 <-[:FOR]-(:Selection {deal_code: $deal, iteration: $iteration})-[:HAS_TASK]->(pt:PlanTask)
  WITH DISTINCT pt
  RETURN CASE WHEN count(pt) = 0 THEN null ELSE sum(pt.weeks_e) END AS integrate_effort
}
CALL (c) {
  OPTIONAL MATCH (b:BuildOption)-[:DELIVERS]->(c)
  RETURN min(b.weeks_e) AS build_effort
}
CALL (c) {
  OPTIONAL MATCH (:PlatformCapability)-[p:PROVIDES]->(c)
  RETURN coalesce(max(p.coverage), 0.0) AS coverage
}
RETURN c.id AS capability_id, [f IN findings | f.id] AS finding_ids, integrate_effort, build_effort, coverage
ORDER BY capability_id
