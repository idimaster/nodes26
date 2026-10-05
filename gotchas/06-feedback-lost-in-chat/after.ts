import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Driver } from 'neo4j-driver';
import { GateStore } from '@planner/gate';
import { ROOT } from '../_shared/fixture.js';

/**
 * After: a rejection is data. The gate server writes Feedback (ON the rejected selection, FROM the gate) and
 * the parsed Overrides; the re-plan is a new Iteration; resolve_feedback links the Feedback RESOLVED_BY the
 * new Selection; and the skill's iteration_diff query answers the architect's question.
 */
export const ITERATION_DIFF = readFileSync(join(ROOT, 'graph/queries/skill/iteration_diff.cypher'), 'utf8');

export async function reject(driver: Driver, deal: string, iteration: number, uc: string, comment: string) {
  const store = new GateStore(driver);
  const { gate_id } = await store.requestGate({ deal, iteration, gate: 'select', subject_ids: [`Selection:${uc}`], summary: `${uc} for review` });
  return store.decide(gate_id, { action: 'reject', comment, by: 'architect' });
}

export const resolve = (driver: Driver, input: { deal: string; iteration: number; feedback_id: string; resolved_by_ids: string[] }) =>
  new GateStore(driver).resolveFeedback(input);
