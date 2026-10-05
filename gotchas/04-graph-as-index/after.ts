import type { Driver } from 'neo4j-driver';
import { GateStore } from '@planner/gate';

/**
 * After: Selection and Candidate are nodes with fit scores (write_candidates, write_selections), linked by
 * ALTERNATIVE_TO. "Which alternatives were within 20 points?" is one query; the gate console runs it
 * (GateStore.listGates) for every selection it shows the architect.
 */
export async function alternativesWithin20(driver: Driver, deal: string, iteration: number, uc: string) {
  const store = new GateStore(driver);
  const { gate_id } = await store.requestGate({ deal, iteration, gate: 'select', subject_ids: [`Selection:${uc}`], summary: 'gotcha 04' });
  const gate = (await store.listGates('pending', deal)).find((g) => g.id === gate_id);
  return gate?.subjects[0]?.alternatives ?? [];
}
