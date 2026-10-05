// Resource load (DESIGN §5.2 step 5): sum(weeks_e) per skill and wave for one iteration's scheduled plan.
MATCH (pt:PlanTask {deal_code: $deal, iteration: $iteration})
WHERE pt.wave IS NOT NULL
RETURN pt.skill AS skill, pt.wave AS wave, sum(pt.weeks_e) AS weeks, count(pt) AS tasks
ORDER BY wave, skill
