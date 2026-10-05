import type { Driver } from 'neo4j-driver';
import { GateStore } from '@planner/gate';
import { loadContext, validate } from '@planner/guard';
import { OntologyService } from '@planner/ontology-mcp';

/**
 * After: the contract is the ontology, not the data. get_ontology answers the same on an empty graph,
 * and the write guard (G6) refuses any label it does not list.
 */
export const allowedLabels = async (driver: Driver, deal: string) =>
  (await new OntologyService(driver, new GateStore(driver), { waitSeconds: 1 }).getOntology(deal)).core.labels.map((l) => l.name);

export const guardDecision = async (driver: Driver, query: string, params: Record<string, unknown>) =>
  validate(query, params, await loadContext(driver, params.deal as string));
