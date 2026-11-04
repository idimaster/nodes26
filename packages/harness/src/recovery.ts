import { GateStore } from '@planner/gate';
import type { Driver } from 'neo4j-driver';
import { normalized, verifyLoadedDataset } from '../../../graph/load/verify.js';

export const RESET_SCOPE = 'Reset deletes ALL per-deal subgraphs and reloads demo deals/history. Catalog and active global term metadata/DDL remain; per-deal approval/evidence history is deleted.';

export async function inspectPlanningState(driver: Driver, deal: string) {
  const gates = await new GateStore(driver).listGates(undefined, deal);
  const result = await driver.executeQuery(
    `MATCH (n)
     WHERE (n.deal_code = $deal AND (n:Iteration OR n:Roadmap OR
       (n:Feedback AND n.status = 'open') OR (n:Override AND n.active = true)))
       OR (n:OntologyTerm AND n.scope = $deal)
     RETURN labels(n) AS labels, properties(n) AS properties ORDER BY elementId(n)`,
    { deal }, { routing: 'READ' },
  );
  return { deal, gates, state: result.records.map(r => normalized(r.toObject())), resetScope: RESET_SCOPE };
}

export async function assertFreshRun(driver: Driver, deal: string) {
  const state = await inspectPlanningState(driver, deal);
  if (state.gates.length || state.state.length) throw new Error(`RECOVERY_REQUIRED: existing planning state for ${deal}. Run npm run planner:recover -- inspect --deal ${deal}. Gate IDs/statuses: ${state.gates.map(g => `${g.id}:${g.status}`).join(', ') || '(none)'}`);
  const readiness = await verifyLoadedDataset(driver, { deal, mode: 'retain-active-global-terms' });
  return { state, readiness };
}
