import type { Driver } from 'neo4j-driver';
import { GateStore } from '@planner/gate';
import { loadContext, validate } from '@planner/guard';
import { OntologyService } from '@planner/ontology-mcp';

/**
 * After: a new concept is proposed (propose_term), approved by the architect at an ontology_term gate,
 * and becomes an active term scoped to the deal. The guard then accepts exactly that name; a variant is
 * denied by G6 and steered to the existing term.
 */
export async function proposeAndApprove(driver: Driver, input: { deal: string; iteration: number; name: string; finding: string }) {
  const store = new GateStore(driver);
  const proposal = new OntologyService(driver, store, { waitSeconds: 20 }).proposeTerm({
    deal: input.deal,
    iteration: input.iteration,
    kind: 'label',
    name: input.name,
    definition: 'A contractual requirement that customer data stays in a region.',
    example: 'EU customer ledgers stay in EU regions, including backups.',
    motivated_by: [input.finding],
  });
  // The architect, in the console.
  for (let i = 0; i < 100; i++) {
    const gate = (await store.listGates('pending', input.deal)).find((g) => g.gate === 'ontology_term');
    if (gate) {
      await store.decide(gate.id, { action: 'approve', comment: '', by: 'architect' });
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return proposal;
}

export const guardDecision = async (driver: Driver, query: string, params: Record<string, unknown>) =>
  validate(query, params, await loadContext(driver, params.deal as string));
