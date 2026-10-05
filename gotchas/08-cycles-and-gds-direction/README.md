# 08: Cycles and GDS direction

**What we did.** We scheduled the plan's tasks with a simple list scheduler, and then moved the critical path to GDS (`gds.dag.longestPath`), projecting `DEPENDS_ON` the way it is stored.

**What broke.**
- **(a) A cycle hangs the scheduler.** Task dependencies come from the catalog plus whatever the agent wrote. With one back edge, no task on the cycle ever becomes ready, and the list scheduler loops forever (the test caps it at 10,000 passes, with nothing scheduled).
- **(b) The projection runs the wrong way.** `DEPENDS_ON` points from a dependent task to its prerequisite. Longest-path over that direction measures how much depends on a task, not when it can start. The first task of the chain gets the latest "earliest start", and the critical path is reversed.

**The fix.** Both live in the server-side scheduler (`packages/graph-mcp/src/schedule.ts`, the agent's `schedule_plan`):
- **(a)** V3, the cycle check, runs first. A cycle stops scheduling with its witness, and nothing is written. The engine's Kahn scheduler also throws `CycleError` with a witness, as a second line of defense.
- **(b)** The projection runs from prerequisite to dependent (`(a)<-[:DEPENDS_ON]-(b)`), weighted by the prerequisite's `weeks_e`. A parity test, repeated here, checks that GDS and the engine's Kahn scheduler agree.

- Before: [`before.ts`](before.ts) (the scheduler) and [`before.cypher`](before.cypher) (the input and the wrong-direction projection)
- After: [`after.ts`](after.ts), using `computeIterationSchedule` with the `gds` and `kahn` engines
- Test: [`test.ts`](test.ts)
