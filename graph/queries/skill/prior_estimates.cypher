// Prior-project estimates (DESIGN §5.3): for each catalog Task, the Actual durations observed on
// committed plans of past deals. One row per asked task, with n = 0 when it was never observed.
UNWIND $task_ids AS task_id
MATCH (t:Task {id: task_id})
OPTIONAL MATCH (a:Actual)-[:OBSERVED_FOR]->(pt:PlanTask)-[:INSTANTIATES]->(t)
WHERE EXISTS { (pt)<-[:HAS_TASK]-(:Selection {status: 'committed'}) }
WITH t, a
ORDER BY a.deal_code, a.plan_task_id
RETURN t.id AS task_id, t.weeks_o AS weeks_o, t.weeks_e AS weeks_e, t.weeks_p AS weeks_p,
       count(a) AS n, avg(a.weeks_actual) AS history_avg, collect(a.weeks_actual) AS observations
ORDER BY task_id
