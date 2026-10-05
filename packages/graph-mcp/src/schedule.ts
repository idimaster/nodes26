import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import neo4j, { type Driver } from 'neo4j-driver';
import { completeSchedule, computeSchedule, CycleError, type Schedule, type ScheduleTask } from '@planner/engine';
import { runValidators } from '../../../graph/validate.js';

/**
 * Server-side scheduling (DESIGN §5.2). The agent asks; the graph decides:
 * 1. V3 first: a cycle stops everything and nothing is written.
 * 2. GDS gds.dag.longestPath.stream on a projection from prerequisite to dependent, weighted by the
 *    prerequisite's weeks_e (earliest start) and by 1 per edge (wave = hops + 1). If the probe finds
 *    no such procedure, the engine's Kahn scheduler runs instead, and the caller is warned.
 * 3. Critical flags, path, finish, and PERT come from the engine's completeSchedule for both engines.
 * 4. One transaction writes earliest_start, wave, and on_critical_path on every PlanTask.
 */

export type Engine = 'gds' | 'kahn';

export type ScheduleOutcome =
  | { status: 'scheduled'; engine: Engine; schedule: Schedule }
  | { status: 'cycle'; source: 'V3' | 'schedule'; witness: string[] };

export interface ScheduleResult {
  status: 'scheduled';
  engine: Engine;
  tasks: number;
  finish: number;
  critical_path: string[];
  pert: Schedule['pert'];
  resource_load: { skill: string; wave: number; weeks: number; tasks: number }[];
}

const RESOURCE_LOAD = readFileSync(fileURLToPath(new URL('../../../graph/queries/resource-load.cypher', import.meta.url)), 'utf8');
const PROCEDURE = 'gds.dag.longestPath.stream';
const num = (v: unknown) => (neo4j.isInt(v) ? (v as { toNumber(): number }).toNumber() : Number(v));

/** Capability probe: is the GDS DAG longest-path procedure installed? */
export async function gdsAvailable(driver: Driver): Promise<boolean> {
  try {
    const { records } = await driver.executeQuery('CALL gds.list() YIELD name WHERE name = $name RETURN count(*) AS n', { name: PROCEDURE });
    return num(records[0]?.get('n')) > 0;
  } catch (e) {
    // Only "GDS is not installed" means absent; anything else (auth, network) is a real error.
    const code = (e as { code?: string }).code ?? '';
    if (code === 'Neo.ClientError.Procedure.ProcedureNotFound' || /no procedure|procedurenotfound/i.test(String(e))) return false;
    throw e;
  }
}

async function loadPlan(driver: Driver, deal: string, iteration: number) {
  const { records } = await driver.executeQuery(
    `MATCH (pt:PlanTask {deal_code: $deal, iteration: $iteration})
     RETURN pt.id AS id, pt.weeks_o AS weeks_o, pt.weeks_e AS weeks_e, pt.weeks_p AS weeks_p,
            COLLECT { MATCH (pt)-[:DEPENDS_ON]->(b:PlanTask {deal_code: $deal, iteration: $iteration}) RETURN b.id } AS deps
     ORDER BY id`,
    { deal, iteration: neo4j.int(iteration) },
    { routing: neo4j.routing.READ },
  );
  const need = (r: (typeof records)[number], k: string) => {
    const v = r.get(k);
    if (v === null || v === undefined) throw new Error(`PlanTask ${String(r.get('id'))} has no ${k}; run write_plan_tasks`);
    return num(v);
  };
  const tasks: ScheduleTask[] = records.map((r) => ({
    id: r.get('id') as string,
    weeks_o: need(r, 'weeks_o'),
    weeks_e: need(r, 'weeks_e'),
    weeks_p: need(r, 'weeks_p'),
  }));
  const dependsOn = records.flatMap((r) => (r.get('deps') as string[]).map((to) => ({ from: r.get('id') as string, to })));
  return { tasks, dependsOn };
}

async function gdsStartsAndWaves(driver: Driver, deal: string, iteration: number) {
  const name = `schedule-${randomUUID()}`;
  await driver.executeQuery(
    `MATCH (a:PlanTask {deal_code: $deal, iteration: $iteration})
     OPTIONAL MATCH (a)<-[:DEPENDS_ON]-(b:PlanTask {deal_code: $deal, iteration: $iteration})
     WITH gds.graph.project($name, a, b, {relationshipProperties: {w: a.weeks_e, hop: 1.0}}) AS g
     RETURN g.nodeCount AS nodes`,
    { deal, iteration: neo4j.int(iteration), name },
  );
  try {
    const stream = async (weight: 'w' | 'hop') =>
      new Map(
        (
          await driver.executeQuery(
            `CALL gds.dag.longestPath.stream($name, {relationshipWeightProperty: $weight}) YIELD targetNode, totalCost
             RETURN gds.util.asNode(targetNode).id AS id, totalCost`,
            { name, weight },
          )
        ).records.map((r) => [r.get('id') as string, num(r.get('totalCost'))]),
      );
    const es = await stream('w');
    const hops = await stream('hop');
    return { es, wave: new Map([...hops].map(([id, h]) => [id, h + 1])) };
  } finally {
    // Never let a failed drop hide the original error.
    await driver.executeQuery('CALL gds.graph.drop($name, false) YIELD graphName RETURN graphName', { name }).catch((e: unknown) => {
      console.error(`planner-graph: could not drop projection ${name}: ${String(e)}`);
    });
  }
}

/** Computes the schedule of one iteration without writing it. */
export async function computeIterationSchedule(
  driver: Driver,
  deal: string,
  iteration: number,
  opts: { engine: Engine },
): Promise<ScheduleOutcome> {
  const { tasks, dependsOn } = await loadPlan(driver, deal, iteration);
  if (tasks.length === 0) throw new Error(`no PlanTasks for deal ${deal}, iteration ${iteration}; run write_plan_tasks first`);

  const [v3] = await runValidators(deal, iteration, { driver, checks: ['V3'] });
  if (!v3) throw new Error('validator V3 is missing; scheduling never runs without it');
  if (v3.verdict === 'FAIL') return { status: 'cycle', source: 'V3', witness: v3.violations[0]?.witness ?? [] };

  const kahn = (): ScheduleOutcome => {
    try {
      return { status: 'scheduled', engine: opts.engine, schedule: computeSchedule(tasks, dependsOn) };
    } catch (e) {
      if (e instanceof CycleError) return { status: 'cycle', source: 'schedule', witness: e.witness };
      throw e;
    }
  };
  if (opts.engine === 'kahn') return kahn();

  const { es, wave } = await gdsStartsAndWaves(driver, deal, iteration);
  // A DAG algorithm leaves out tasks on a cycle (one longer than V3 checks); Kahn then gives the witness.
  if (tasks.some((t) => !es.has(t.id) || !wave.has(t.id))) {
    const outcome = kahn();
    if (outcome.status === 'cycle') return outcome;
    throw new Error('GDS did not schedule every task, but the plan has no cycle');
  }
  return { status: 'scheduled', engine: 'gds', schedule: completeSchedule(tasks, dependsOn, es, wave) };
}

/** Schedules one iteration and writes the result back. This is what the agent's schedule_plan tool runs. */
export async function scheduleIteration(
  driver: Driver,
  deal: string,
  iteration: number,
  opts: { probe?: (driver: Driver) => Promise<boolean>; warn?: (message: string) => void } = {},
): Promise<ScheduleResult | Extract<ScheduleOutcome, { status: 'cycle' }>> {
  const available = await (opts.probe ?? gdsAvailable)(driver);
  if (!available) {
    (opts.warn ?? ((m: string) => console.error(m)))(
      `planner-graph: ${PROCEDURE} is not available in this GDS; scheduling with the engine's Kahn algorithm (DESIGN §5.2)`,
    );
  }
  const outcome = await computeIterationSchedule(driver, deal, iteration, { engine: available ? 'gds' : 'kahn' });
  if (outcome.status === 'cycle') return outcome;

  const { schedule } = outcome;
  // One transaction: the plan must be exactly the one scheduled, or nothing is written.
  const session = driver.session();
  let written: number;
  try {
    written = await session.executeWrite(async (tx) => {
      const params = { deal, iteration: neo4j.int(iteration) };
      const now = await tx.run('MATCH (pt:PlanTask {deal_code: $deal, iteration: $iteration}) RETURN count(pt) AS n', params);
      if (num(now.records[0]?.get('n')) !== schedule.tasks.length) {
        throw new Error('the plan changed while it was being scheduled; schedule again');
      }
      const res = await tx.run(
        `UNWIND $rows AS row
         MATCH (pt:PlanTask {deal_code: $deal, iteration: $iteration, id: row.id})
         SET pt.earliest_start = row.earliest_start, pt.wave = row.wave, pt.on_critical_path = row.on_critical_path
         RETURN count(pt) AS written`,
        { ...params, rows: schedule.tasks.map((t) => ({ ...t, wave: neo4j.int(t.wave) })) },
      );
      const n = num(res.records[0]?.get('written'));
      if (n !== schedule.tasks.length) throw new Error(`could write the schedule of only ${n} of ${schedule.tasks.length} PlanTasks`);
      return n;
    });
  } finally {
    await session.close();
  }

  const load = await driver.executeQuery(RESOURCE_LOAD, { deal, iteration: neo4j.int(iteration) }, { routing: neo4j.routing.READ });
  return {
    status: 'scheduled',
    engine: outcome.engine,
    tasks: written,
    finish: schedule.finish,
    critical_path: schedule.critical_path,
    pert: schedule.pert,
    resource_load: load.records.map((r) => ({
      skill: r.get('skill') as string,
      wave: num(r.get('wave')),
      weeks: num(r.get('weeks')),
      tasks: num(r.get('tasks')),
    })),
  };
}
