import type { Driver } from 'neo4j-driver';
import { computeIterationSchedule, type Engine } from '@planner/graph-mcp';

/**
 * After: the server-side scheduler (schedule_plan). It runs V3 first, so a cycle stops it with a witness
 * before anything is computed, and its GDS projection runs from prerequisite to dependent, the opposite of
 * how DEPENDS_ON is stored. Its result matches the engine's Kahn scheduler.
 */
export async function schedule(driver: Driver, deal: string, iteration: number, engine: Engine) {
  return computeIterationSchedule(driver, deal, iteration, { engine });
}

export async function earliestStarts(driver: Driver, deal: string, iteration: number, engine: Engine) {
  const outcome = await schedule(driver, deal, iteration, engine);
  if (outcome.status !== 'scheduled') throw new Error(`expected a schedule, got a cycle: ${outcome.witness.join(' -> ')}`);
  return Object.fromEntries(outcome.schedule.tasks.map((t) => [t.id, t.earliest_start]));
}
